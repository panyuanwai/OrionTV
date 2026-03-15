import React, { useEffect, useRef, useCallback, memo, useMemo, useState } from "react";
import { StyleSheet, TouchableOpacity, BackHandler, AppState, AppStateStatus, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Video } from "expo-av";
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
import { useVideoHandlers } from "@/hooks/useVideoHandlers";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('PlayScreen');

// 全局变量：追踪上一个 ExoPlayer 的释放 Promise
// 用于确保新的 Video 组件只有在上一个完全释放后才挂载
let _lastUnloadPromise: Promise<void> | null = null;

/**
 * 安全地释放 Video 组件的 ExoPlayer 资源
 * 返回一个 Promise，当资源完全释放后 resolve
 */
async function safeUnloadVideo(videoRef: React.RefObject<Video>): Promise<void> {
  if (!videoRef.current) return;

  const startTime = Date.now();
  logger.info(`[CLEANUP] Starting safe unload...`);

  try {
    // 先暂停，确保 ExoPlayer 停止渲染
    await videoRef.current.pauseAsync().catch(() => { });

    // 然后停止播放
    await videoRef.current.stopAsync().catch(() => { });

    // 最后卸载，释放 MediaCodec 和 Surface
    await videoRef.current.unloadAsync().catch(() => { });

    logger.info(`[CLEANUP] Safe unload completed in ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.warn(`[CLEANUP] Error during safe unload (${Date.now() - startTime}ms):`, error);
  }

  // 额外等待 300ms，让 Android 系统有时间完全回收硬件解码器
  // 这在 Chromecast 等低资源设备上至关重要
  await new Promise(resolve => setTimeout(resolve, 300));
  logger.info(`[CLEANUP] Hardware decoder release wait completed`);
}

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

  // 关键修复 #1: 延迟挂载 Video 组件
  // 在 Chromecast 上，旧的 ExoPlayer 可能还没释放完硬件解码器
  // 需要等待上一次的 unloadAsync 完成后再挂载新的 Video
  const [videoReady, setVideoReady] = useState(false);

  // 用于追踪 app 是否从后台恢复
  const appStateRef = useRef(AppState.currentState);
  const isCleaningUpRef = useRef(false);

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

  // 使用Video事件处理hook
  const { videoProps } = useVideoHandlers({
    videoRef,
    currentEpisode,
    initialPosition,
    introEndTime,
    playbackRate,
    handlePlaybackStatusUpdate,
    deviceType,
    detail: detail || undefined,
  });

  // TV遥控器处理
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  // 关键修复 #2: 延迟挂载 Video 组件直到确认旧 ExoPlayer 已释放
  useEffect(() => {
    let cancelled = false;

    const waitAndMount = async () => {
      logger.info(`[MOUNT] PlayScreen mounting - checking for pending unload...`);

      // 等待上一个 Video 的 unloadAsync 完成
      if (_lastUnloadPromise) {
        logger.info(`[MOUNT] Waiting for previous ExoPlayer to release...`);
        await _lastUnloadPromise;
        _lastUnloadPromise = null;
        logger.info(`[MOUNT] Previous ExoPlayer released successfully`);
      }

      // 额外安全延迟：给 Chromecast 的硬件解码器时间完全回收
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!cancelled) {
        logger.info(`[MOUNT] Video component ready to mount`);
        setVideoReady(true);
      }
    };

    waitAndMount();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayScreen useEffect START - source: ${source}, id: ${id}, title: ${title}`);

    setVideoRef(videoRef);
    if (source && id && title) {
      logger.info(`[PERF] Calling loadVideo with episodeIndex: ${episodeIndex}, position: ${position}`);
      loadVideo({ source, id, episodeIndex, position, title });
    } else {
      logger.info(`[PERF] Missing required params - source: ${!!source}, id: ${!!id}, title: ${!!title}`);
    }

    const perfEnd = performance.now();
    logger.info(`[PERF] PlayScreen useEffect END - took ${(perfEnd - perfStart).toFixed(2)}ms`);

    // 关键修复 #3: cleanup 时保存 unload promise 到全局变量
    return () => {
      logger.info(`[PERF] PlayScreen unmounting - starting safe cleanup`);

      // 将 unload 操作保存为全局 Promise
      // 这样下一次 PlayScreen 挂载时可以等待它完成
      _lastUnloadPromise = safeUnloadVideo(videoRef);

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

  // 关键修复 #4: AppState 监听器 - 后台化时暂停，恢复时重新播放
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState === "background" || nextAppState === "inactive") {
        // 进入后台：暂停视频
        logger.info(`[APPSTATE] App going to background, pausing video`);
        videoRef.current?.pauseAsync().catch(() => { });
      } else if (
        nextAppState === "active" &&
        (prevState === "background" || prevState === "inactive")
      ) {
        // 从后台恢复：强制重新加载视频源
        logger.info(`[APPSTATE] App returning to foreground, attempting recovery`);

        // 延迟恢复：给 Android 系统时间重新初始化 SurfaceView
        setTimeout(async () => {
          if (!videoRef.current) return;

          try {
            // 先尝试直接播放
            await videoRef.current.playAsync();
            logger.info(`[APPSTATE] Direct playAsync succeeded after resume`);
          } catch (error) {
            logger.warn(`[APPSTATE] Direct playAsync failed, trying full reload...`);

            try {
              // 如果直接播放失败，完全重新加载
              const episode = usePlayerStore.getState();
              const currentEp = selectCurrentEpisode(episode);
              if (currentEp?.url) {
                const currentPosition = episode.status?.isLoaded
                  ? episode.status.positionMillis
                  : 0;

                await videoRef.current.unloadAsync();
                await new Promise(r => setTimeout(r, 300));
                await videoRef.current.loadAsync(
                  { uri: currentEp.url },
                  { positionMillis: currentPosition, shouldPlay: true }
                );
                logger.info(`[APPSTATE] Full reload succeeded after resume`);
              }
            } catch (reloadError) {
              logger.error(`[APPSTATE] Full reload failed:`, reloadError);
            }
          }
        }, 500);
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
    };
  }, []);

  // 关键修复 #5: BackHandler 先 await 清理再导航
  useEffect(() => {
    const backAction = () => {
      if (showControls) {
        setShowControls(false);
        return true;
      }

      if (isCleaningUpRef.current) {
        // 防止重复点击返回导致多次清理
        return true;
      }

      // 返回 true 先阻止默认行为
      // 然后异步完成清理后再导航
      isCleaningUpRef.current = true;

      (async () => {
        logger.info(`[BACK] Back pressed - starting cleanup before navigation`);

        // 先完成 ExoPlayer 清理
        await safeUnloadVideo(videoRef);

        logger.info(`[BACK] Cleanup complete - navigating back`);
        router.back();
        isCleaningUpRef.current = false;
      })();

      return true; // 阻止默认
    };

    const backHandler = BackHandler.addEventListener("hardwareBackPress", backAction);

    return () => backHandler.remove();
  }, [showControls, setShowControls, router]);

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
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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
        {/* 关键修复: 只有在 videoReady 为 true（旧 ExoPlayer 已释放）时才渲染 Video */}
        {videoReady && currentEpisode?.url ? (
          <Video ref={videoRef} style={dynamicStyles.videoPlayer} {...videoProps} />
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
