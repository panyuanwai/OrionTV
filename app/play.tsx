import React, { useEffect, useRef, useCallback, memo, useMemo, useState } from "react";
import { StyleSheet, TouchableOpacity, BackHandler, AppState, AppStateStatus, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Video, Audio, ResizeMode } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";
import { ThemedView } from "@/components/ThemedView";
import { PlayerControls } from "@/components/PlayerControls";
import { EpisodeSelectionModal } from "@/components/EpisodeSelectionModal";
import { SourceSelectionModal } from "@/components/SourceSelectionModal";
import { SpeedSelectionModal } from "@/components/SpeedSelectionModal";
import { SeekingBar } from "@/components/SeekingBar";
// import { NextEpisodeOverlay } from "@/components/NextEpisodeOverlay";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import useDetailStore from "@/stores/detailStore";
import { useTVRemoteHandler } from "@/hooks/useTVRemoteHandler";
import Toast from "react-native-toast-message";
import usePlayerStore, { selectCurrentEpisode } from "@/stores/playerStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('PlayScreen');

// 优化的加载动画组件
const LoadingContainer = memo(
  ({ style, currentEpisode }: { style: any; currentEpisode: { url: string; title: string } | undefined }) => {
    logger.info(
      `[PERF] Video component NOT rendered - waiting for valid URL. currentEpisode: ${!!currentEpisode}, url: ${currentEpisode?.url ? "exists" : "missing"
      }`
    );
    return (
      <View style={style}>
        <VideoLoadingAnimation showProgressBar />
      </View>
    );
  }
);

LoadingContainer.displayName = "LoadingContainer";

// 移到组件外部避免重复创建
const createResponsiveStyles = (deviceType: string) => {
  const isMobile = deviceType === "mobile";
  const isTablet = deviceType === "tablet";

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: "black",
      ...(isMobile || isTablet ? { paddingTop: 0 } : {}),
    },
    videoContainer: {
      ...StyleSheet.absoluteFillObject,
      ...(isMobile || isTablet ? { zIndex: 1 } : {}),
    },
    videoPlayer: {
      ...StyleSheet.absoluteFillObject,
    },
    loadingContainer: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 10,
    },
  });
};

export default function PlayScreen() {
  const videoRef = useRef<Video>(null);
  const router = useRouter();
  useKeepAwake();

  // 关键修复: Video 组件始终挂载（无源），然后手动 loadAsync
  // 这样我们可以完全控制 ExoPlayer 的生命周期
  const [manualLoadDone, setManualLoadDone] = useState(false);
  const appStateRef = useRef(AppState.currentState);
  const isNavigatingBack = useRef(false);

  // 用于强制重建 Video 组件的 key
  const [videoKey, setVideoKey] = useState(0);

  // 响应式布局配置
  const { deviceType } = useResponsiveLayout();

  const {
    episodeIndex: episodeIndexStr,
    position: positionStr,
    source: sourceStr,
    id: videoId,
    title: videoTitle,
  } = useLocalSearchParams<{
    episodeIndex: string;
    position?: string;
    source?: string;
    id?: string;
    title?: string;
  }>();
  const episodeIndex = parseInt(episodeIndexStr || "0", 10);
  const position = positionStr ? parseInt(positionStr, 10) : undefined;

  const { detail } = useDetailStore();
  const source = sourceStr || detail?.source;
  const id = videoId || detail?.id.toString();
  const title = videoTitle || detail?.title;
  const {
    isLoading,
    showControls,
    initialPosition,
    introEndTime,
    playbackRate,
    setVideoRef,
    handlePlaybackStatusUpdate,
    setShowControls,
    reset,
    loadVideo,
  } = usePlayerStore();
  const currentEpisode = usePlayerStore(selectCurrentEpisode);

  // TV遥控器处理
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  // 关键修复: 手动 loadAsync 而非通过 source prop
  // 这样可以在加载前重置 Audio 引擎，确保 ExoPlayer 获得干净的状态
  useEffect(() => {
    if (!currentEpisode?.url || !videoRef.current || manualLoadDone) return;

    let cancelled = false;

    const doManualLoad = async () => {
      logger.info(`[MANUAL_LOAD] Starting manual load for: ${currentEpisode.url.substring(0, 80)}...`);

      try {
        // 步骤1: 重置 Audio 引擎 — 清除进程级的音频会话状态
        // 这是解决 Activity 重建后 MediaCodec 损坏的关键
        logger.info(`[MANUAL_LOAD] Step 1: Resetting Audio engine`);
        await Audio.setAudioModeAsync({
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });

        if (cancelled) return;

        // 步骤2: 确保 Video 组件的旧内容被完全清除
        logger.info(`[MANUAL_LOAD] Step 2: Unloading any stale content`);
        try {
          await videoRef.current?.unloadAsync();
        } catch (e) {
          // 忽略 — 可能没有之前的内容
        }

        if (cancelled) return;

        // 步骤3: 等待 Android 系统释放硬件解码器
        logger.info(`[MANUAL_LOAD] Step 3: Waiting for hardware decoder release`);
        await new Promise(resolve => setTimeout(resolve, 500));

        if (cancelled || !videoRef.current) return;

        // 步骤4: 手动加载视频
        const jumpPosition = initialPosition || introEndTime || 0;
        logger.info(`[MANUAL_LOAD] Step 4: Loading video with position ${jumpPosition}ms`);

        await videoRef.current.loadAsync(
          { uri: currentEpisode.url },
          {
            positionMillis: jumpPosition,
            shouldPlay: true,
            rate: playbackRate,
            progressUpdateIntervalMillis: 1000,
          }
        );

        if (cancelled) return;

        logger.info(`[MANUAL_LOAD] Video loaded successfully!`);
        setManualLoadDone(true);
        usePlayerStore.setState({ isLoading: false });

      } catch (error: any) {
        if (cancelled) return;
        logger.error(`[MANUAL_LOAD] Failed to load video:`, error);

        // 如果加载失败，尝试切换播放源
        const errorStr = error?.toString() || '';
        if (errorStr.includes('SSL') || errorStr.includes('Certificate')) {
          usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
        } else if (errorStr.includes('Http') || errorStr.includes('IO') || errorStr.includes('Socket')) {
          usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
        } else {
          usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
        }
      }
    };

    doManualLoad();

    return () => {
      cancelled = true;
    };
  }, [currentEpisode?.url, manualLoadDone, initialPosition, introEndTime, playbackRate]);

  useEffect(() => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayScreen useEffect START - source: ${source}, id: ${id}, title: ${title}`);

    setVideoRef(videoRef);
    if (source && id && title) {
      loadVideo({ source, id, episodeIndex, position, title });
    }

    const perfEnd = performance.now();
    logger.info(`[PERF] PlayScreen useEffect END - took ${(perfEnd - perfStart).toFixed(2)}ms`);

    return () => {
      logger.info(`[CLEANUP] PlayScreen unmounting`);
      // 同步调用 reset — 不需要等待 unloadAsync，
      // 因为 Video 组件卸载时 expo-av 会自动释放原生资源
      reset();
    };
  }, [episodeIndex, source, position, setVideoRef, reset, loadVideo, id, title]);

  // 优化的屏幕点击处理
  const onScreenPress = useCallback(() => {
    if (deviceType === "tv") {
      tvRemoteHandler.onScreenPress();
    } else {
      setShowControls(!showControls);
    }
  }, [deviceType, tvRemoteHandler, setShowControls, showControls]);

  // AppState 监听: 后台恢复时完全重建 Video
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState === "background" || nextAppState === "inactive") {
        logger.info(`[APPSTATE] Going to background, pausing`);
        videoRef.current?.pauseAsync().catch(() => { });
      } else if (
        nextAppState === "active" &&
        (prevState === "background" || prevState === "inactive")
      ) {
        // 关键修复: 从后台恢复时，完全重建 Video 组件
        // 通过改变 key 强制 React 销毁旧组件并创建新组件
        // 再通过 manualLoadDone=false 触发重新加载
        logger.info(`[APPSTATE] Returning from background - forcing Video recreation`);
        setManualLoadDone(false);
        setVideoKey(prev => prev + 1);
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, []);

  // 返回键处理: 先清理再导航
  useEffect(() => {
    const backAction = () => {
      if (showControls) {
        setShowControls(false);
        return true;
      }

      if (isNavigatingBack.current) return true;
      isNavigatingBack.current = true;

      // 异步清理后导航
      (async () => {
        try {
          if (videoRef.current) {
            await videoRef.current.pauseAsync().catch(() => { });
            await videoRef.current.stopAsync().catch(() => { });
            await videoRef.current.unloadAsync().catch(() => { });
            // 等待硬件解码器释放
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (e) {
          logger.warn(`[BACK] Cleanup error:`, e);
        }
        router.back();
        isNavigatingBack.current = false;
      })();

      return true;
    };

    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);
    return () => backHandler.remove();
  }, [showControls, setShowControls, router]);

  // 播放超时检测
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;

    if (isLoading) {
      timeoutId = setTimeout(() => {
        if (usePlayerStore.getState().isLoading) {
          usePlayerStore.setState({ isLoading: false });
          Toast.show({ type: "error", text1: "播放超时，请重试" });
        }
      }, 60000);
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isLoading]);

  if (!detail) {
    return <VideoLoadingAnimation showProgressBar />;
  }

  return (
    <ThemedView focusable style={dynamicStyles.container}>
      <TouchableOpacity
        activeOpacity={1}
        style={dynamicStyles.videoContainer}
        onPress={onScreenPress}
        disabled={deviceType !== "tv" && showControls}
      >
        {/* 关键修复: Video 组件始终挂载（不依赖 URL），使用 key 控制重建 */}
        {/* source 不通过 prop 传入，而是通过 loadAsync 手动加载 */}
        {currentEpisode?.url ? (
          <Video
            key={`video-${videoKey}`}
            ref={videoRef}
            style={dynamicStyles.videoPlayer}
            resizeMode={ResizeMode.CONTAIN}
            onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
            useNativeControls={deviceType !== 'tv'}
          />
        ) : (
          <LoadingContainer style={dynamicStyles.loadingContainer} currentEpisode={currentEpisode} />
        )}

        {showControls && deviceType === "tv" && (
          <PlayerControls showControls={showControls} setShowControls={setShowControls} />
        )}

        <SeekingBar />

        {currentEpisode?.url && isLoading && (
          <View style={dynamicStyles.loadingContainer}>
            <VideoLoadingAnimation showProgressBar />
          </View>
        )}
      </TouchableOpacity>

      <EpisodeSelectionModal />
      <SourceSelectionModal />
      <SpeedSelectionModal />
    </ThemedView>
  );
}
