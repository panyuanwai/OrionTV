import React, { useEffect, useRef, useCallback, memo, useMemo, useState } from "react";
import { StyleSheet, TouchableOpacity, BackHandler, AppState, AppStateStatus, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
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
import { useAppStateStore } from "@/stores/appStateStore";
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
  const videoRef = useRef<Video>(null);
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
    setVideoRef,
    handlePlaybackStatusUpdate,
    setShowControls,
    // setShowNextEpisodeOverlay,
    reset,
    loadVideo,
  } = usePlayerStore();
  const currentEpisode = usePlayerStore(selectCurrentEpisode);
  const consumeResumedFromBackground = useAppStateStore((state) => state.consumeResumedFromBackground);

  const [videoInstanceKey, setVideoInstanceKey] = useState(0);
  const [disableInitialSeek, setDisableInitialSeek] = useState(false);

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
    disableInitialSeek,
  });

  // TV遥控器处理 - 总是调用hook，但根据设备类型决定是否使用结果
  const tvRemoteHandler = useTVRemoteHandler();

  // 优化的动态样式 - 使用useMemo避免重复计算
  const dynamicStyles = useMemo(() => createResponsiveStyles(deviceType), [deviceType]);

  const isRecoveringRef = useRef(false);
  const lastRecoverAtRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const forceRecreatePlayer = useCallback(async (reason: "app-active" | "screen-focus") => {
    if (deviceType !== "tv") return;

    logger.warn(`[RECOVER] Force recreating video instance due to ${reason}`);
    setDisableInitialSeek(true);

    try {
      await videoRef.current?.stopAsync?.();
    } catch (error) {
      logger.warn(`[RECOVER] stopAsync failed before recreate on ${reason}`, error);
    }

    try {
      await videoRef.current?.unloadAsync?.();
    } catch (error) {
      logger.warn(`[RECOVER] unloadAsync failed before recreate on ${reason}`, error);
    }

    setVideoInstanceKey((prev) => prev + 1);

    setTimeout(() => {
      setDisableInitialSeek(false);
    }, 2500);
  }, [deviceType]);

  const recoverPlayback = useCallback(
    async (reason: "app-active" | "screen-focus") => {
      if (deviceType !== "tv" || !currentEpisode?.url) {
        return;
      }

      const now = Date.now();
      if (isRecoveringRef.current || now - lastRecoverAtRef.current < 1200) {
        return;
      }

      isRecoveringRef.current = true;
      lastRecoverAtRef.current = now;

      try {
        if (reason === "app-active") {
          await forceRecreatePlayer(reason);
          return;
        }

        const player = videoRef.current;
        if (!player) return;

        const status = await player.getStatusAsync();
        if (status.isLoaded) {
          const currentPosition = Math.max(0, status.positionMillis || 0);
          await player.playAsync();
          // Android TV 某些机型需要“微跳帧”才能真正唤醒渲染管线
          await player.setPositionAsync(currentPosition + 1);
          await player.setPositionAsync(currentPosition);

          const verify = await player.getStatusAsync();
          if (!verify.isLoaded || !verify.isPlaying) {
            throw new Error("resume verification failed");
          }

          logger.info(`[RECOVER] Playback resumed by ${reason} at ${currentPosition}ms`);
          return;
        }

        throw new Error("player status not loaded");
      } catch (error) {
        logger.warn(`[RECOVER] Resume failed on ${reason}, fallback to reload current source`, error);

        try {
          const player = videoRef.current;
          if (!player || !currentEpisode?.url) return;

          await player.unloadAsync();
          await player.loadAsync(
            { uri: currentEpisode.url },
            {
              shouldPlay: true,
              positionMillis: Math.max(0, initialPosition || 0),
              rate: playbackRate,
              shouldCorrectPitch: true,
            }
          );

          logger.info(`[RECOVER] Reloaded current source by ${reason}`);
        } catch (reloadError) {
          logger.error(`[RECOVER] Reload fallback failed on ${reason}`, reloadError);
        }
      } finally {
        isRecoveringRef.current = false;
      }
    },
    [deviceType, currentEpisode?.url, initialPosition, playbackRate, forceRecreatePlayer]
  );

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

    return () => {
      logger.info(`[PERF] PlayScreen unmounting - unloading player and calling reset()`);
      videoRef.current?.unloadAsync?.().catch((error) => {
        logger.warn(`[CLEANUP] Failed to unload video on unmount`, error);
      });
      reset(); // Reset state when component unmounts
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

  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextAppState;

      try {
        if (nextAppState === "background" || nextAppState === "inactive") {
          await videoRef.current?.pauseAsync();
          return;
        }

        const resumedFromBackground =
          nextAppState === "active" && (prevState === "background" || prevState === "inactive");

        if (resumedFromBackground) {
          await recoverPlayback("app-active");
        }
      } catch (error) {
        logger.warn(`[APPSTATE] Failed to handle app state change: ${nextAppState}`, error);
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
    };
  }, [recoverPlayback]);

  useFocusEffect(
    useCallback(() => {
      const resumedFromBackground = consumeResumedFromBackground();
      if (resumedFromBackground) {
        logger.info("[APPSTATE] Global resume flag consumed in PlayScreen focus, forcing recreate");
        forceRecreatePlayer("screen-focus");
      } else {
        recoverPlayback("screen-focus");
      }
      return undefined;
    }, [recoverPlayback, forceRecreatePlayer, consumeResumedFromBackground])
  );

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
        {/* 条件渲染Video组件：只有在有有效URL时才渲染 */}
        {currentEpisode?.url ? (
          <Video key={`${currentEpisode.url}-${videoInstanceKey}`} ref={videoRef} style={dynamicStyles.videoPlayer} {...videoProps} />
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
