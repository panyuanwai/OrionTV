import React, { useEffect, useRef, useCallback, memo, useMemo, useState } from "react";
import { StyleSheet, TouchableOpacity, BackHandler, AppState, AppStateStatus, View, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
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
      `[PERF] Video component NOT rendered - waiting for valid URL. currentEpisode: ${!!currentEpisode}, url: ${
        currentEpisode?.url ? "exists" : "missing"
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
      // 移动端和平板端可能需要状态栏处理
      ...(isMobile || isTablet ? { paddingTop: 0 } : {}),
    },
    videoContainer: {
      ...StyleSheet.absoluteFillObject,
      // 为触摸设备添加更多的交互区域
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
  const router = useRouter();
  useKeepAwake();

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
    // showNextEpisodeOverlay,
    initialPosition,
    introEndTime,
    playbackRate,
    handlePlaybackStatusUpdate,
    setShowControls,
    // setShowNextEpisodeOverlay,
    reset,
    loadVideo,
  } = usePlayerStore();
  const currentEpisode = usePlayerStore(selectCurrentEpisode);

  // expo-video: 使用 useVideoPlayer hook 创建播放器实例
  // useVideoPlayer 会在组件卸载时自动清理底层 ExoPlayer 资源
  // 这是解决 Chromecast 卡帧问题的关键 — expo-av 的 Video 组件不会自动释放
  const videoUrl = currentEpisode?.url || '';
  const player = useVideoPlayer(videoUrl, (player) => {
    logger.info(`[EXPO-VIDEO] Player created/source changed for: ${videoUrl.substring(0, 80)}...`);
    player.playbackRate = playbackRate;

    // 设置初始播放位置
    const jumpPosition = initialPosition || introEndTime || 0;
    if (jumpPosition > 0) {
      logger.info(`[EXPO-VIDEO] Setting initial position to ${jumpPosition}ms (${jumpPosition / 1000}s)`);
      player.currentTime = jumpPosition / 1000; // expo-video 使用秒为单位
    }

    // 自动开始播放
    player.play();
  });

  // 将 player 实例保存到 store 中供其他组件使用
  useEffect(() => {
    usePlayerStore.setState({ videoPlayer: player });
    return () => {
      usePlayerStore.setState({ videoPlayer: null });
    };
  }, [player]);

  // 监听播放器状态变化
  useEffect(() => {
    if (!player) return;

    const statusSub = player.addListener('statusChange', (newStatus: any) => {
      logger.info(`[EXPO-VIDEO] Status changed: ${JSON.stringify(newStatus)}`);
      if (newStatus.status === 'readyToPlay') {
        usePlayerStore.setState({ isLoading: false });
      } else if (newStatus.status === 'error') {
        logger.error(`[EXPO-VIDEO] Player error: ${JSON.stringify(newStatus.error)}`);
        usePlayerStore.setState({ isLoading: false });
        if (currentEpisode?.url) {
          usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
        }
      }
    });

    // 定期更新播放进度（用于进度条和播放记录保存）
    const timeUpdateInterval = setInterval(() => {
      if (player && player.playing) {
        const positionMillis = (player.currentTime || 0) * 1000;
        const durationMillis = (player.duration || 0) * 1000;
        const isPlaying = player.playing;

        if (durationMillis > 0) {
          const progressPosition = positionMillis / durationMillis;
          const avCompatStatus = {
            isLoaded: true,
            isPlaying,
            positionMillis,
            durationMillis,
            didJustFinish: false,
          };
          handlePlaybackStatusUpdate(avCompatStatus);
        }
      }
    }, 1000);

    return () => {
      statusSub.remove();
      clearInterval(timeUpdateInterval);
    };
  }, [player, currentEpisode?.url, handlePlaybackStatusUpdate]);

  // 监听播放完成事件
  useEffect(() => {
    if (!player) return;

    const endSub = player.addListener('playToEnd', () => {
      logger.info(`[EXPO-VIDEO] Playback reached end`);
      const avCompatStatus = {
        isLoaded: true,
        isPlaying: false,
        positionMillis: (player.duration || 0) * 1000,
        durationMillis: (player.duration || 0) * 1000,
        didJustFinish: true,
      };
      handlePlaybackStatusUpdate(avCompatStatus);
    });

    return () => {
      endSub.remove();
    };
  }, [player, handlePlaybackStatusUpdate]);

  // TV遥控器处理 - 总是调用hook，但根据设备类型决定是否使用结果
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式 - 使用useMemo避免重复计算
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  useEffect(() => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayScreen useEffect START - source: ${source}, id: ${id}, title: ${title}`);

    if (source && id && title) {
      logger.info(`[PERF] Calling loadVideo with episodeIndex: ${episodeIndex}, position: ${position}`);
      loadVideo({ source, id, episodeIndex, position, title });
    } else {
      logger.info(`[PERF] Missing required params - source: ${!!source}, id: ${!!id}, title: ${!!title}`);
    }

    const perfEnd = performance.now();
    logger.info(`[PERF] PlayScreen useEffect END - took ${(perfEnd - perfStart).toFixed(2)}ms`);

    return () => {
      logger.info(`[PERF] PlayScreen unmounting - expo-video player will auto-cleanup`);
      // expo-video 的 useVideoPlayer 会自动释放底层 ExoPlayer 资源
      // 这里只需要重置 store 状态
      reset();
    };
  }, [episodeIndex, source, position, reset, loadVideo, id, title]);

  // 优化的屏幕点击处理
  const onScreenPress = useCallback(() => {
    if (deviceType === "tv") {
      tvRemoteHandler.onScreenPress();
    } else {
      setShowControls(!showControls);
    }
  }, [deviceType, tvRemoteHandler, setShowControls, showControls]);

  // AppState 生命周期管理
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      try {
        if (nextAppState === "background" || nextAppState === "inactive") {
          logger.info(`[APPSTATE] App going to background, pausing player`);
          player?.pause();
        } else if (
          nextAppState === "active" &&
          (appStateRef.current === "background" || appStateRef.current === "inactive")
        ) {
          logger.info(`[APPSTATE] App returning to foreground, resuming player`);
          // expo-video 的 player 在恢复时应该能正常工作
          // 因为 useVideoPlayer 管理了底层 ExoPlayer 的完整生命周期
          player?.play();
        }
        appStateRef.current = nextAppState;
      } catch (error) {
        logger.warn(`[APPSTATE] Failed to handle app state change: ${nextAppState}`, error);
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    const backAction = () => {
      if (showControls) {
        setShowControls(false);
        return true;
      }
      router.back();
      return true;
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
      }, 60000); // 1 minute
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
        disabled={deviceType !== "tv" && showControls} // 移动端和平板端在显示控制条时禁用触摸
      >
        {/* 条件渲染VideoView组件：只有在有有效URL时才渲染 */}
        {currentEpisode?.url ? (
          <VideoView
            style={dynamicStyles.videoPlayer}
            player={player}
            contentFit="contain"
            nativeControls={deviceType !== 'tv'}
          />
        ) : (
          <LoadingContainer style={dynamicStyles.loadingContainer} currentEpisode={currentEpisode} />
        )}

        {showControls && deviceType === "tv" && (
          <PlayerControls showControls={showControls} setShowControls={setShowControls} />
        )}

        <SeekingBar />

        {/* 只在Video组件存在且正在加载时显示加载动画覆盖层 */}
        {currentEpisode?.url && isLoading && (
          <View style={dynamicStyles.loadingContainer}>
            <VideoLoadingAnimation showProgressBar />
          </View>
        )}

        {/* <NextEpisodeOverlay visible={showNextEpisodeOverlay} onCancel={() => setShowNextEpisodeOverlay(false)} /> */}
      </TouchableOpacity>

      <EpisodeSelectionModal />
      <SourceSelectionModal />
      <SpeedSelectionModal />
    </ThemedView>
  );
}
