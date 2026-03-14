import { useCallback, RefObject, useMemo } from 'react';
import { Video, ResizeMode } from 'expo-av';
import Toast from 'react-native-toast-message';
import usePlayerStore from '@/stores/playerStore';

interface UseVideoHandlersProps {
  videoRef: RefObject<Video>;
  currentEpisode: { url: string; title: string } | undefined;
  initialPosition: number;
  introEndTime?: number;
  playbackRate: number;
  handlePlaybackStatusUpdate: (status: any) => void;
  deviceType: string;
  detail?: { poster?: string };
  disableInitialSeek?: boolean;
}

export const useVideoHandlers = ({
  videoRef,
  currentEpisode,
  initialPosition,
  introEndTime,
  playbackRate,
  handlePlaybackStatusUpdate,
  deviceType,
  detail,
  disableInitialSeek = false,
}: UseVideoHandlersProps) => {
  
  const onLoad = useCallback(async () => {
    console.info(`[PERF] Video onLoad - video ready to play`);

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      const player = videoRef.current;
      if (!player) {
        usePlayerStore.setState({ isLoading: false });
        return;
      }

      // 1) 先设置位置（历史续播/跳片头）
      const rawJumpPosition = disableInitialSeek ? 0 : (initialPosition || introEndTime || 0);
      const jumpPosition = Math.max(0, rawJumpPosition);
      if (jumpPosition > 0) {
        console.info(`[PERF] Setting initial position to ${jumpPosition}ms`);
        await player.setPositionAsync(jumpPosition);
      }

      // 2) 显式播放
      console.info(`[AUTOPLAY] Attempting to start playback after onLoad`);
      await player.playAsync();

      // 3) TV 续播点首帧卡死兜底：检测 position 是否推进
      const before = await player.getStatusAsync();
      const beforePos = before.isLoaded ? before.positionMillis : 0;
      await sleep(800);
      const after = await player.getStatusAsync();
      const afterPos = after.isLoaded ? after.positionMillis : 0;

      const notProgressing = before.isLoaded && after.isLoaded && afterPos <= beforePos;
      if (notProgressing) {
        console.warn(`[AUTOPLAY] Position stuck at ${afterPos}ms, applying frame-wakeup fallback`);

        // 3.1 微跳帧唤醒
        await player.setPositionAsync(afterPos + 1);
        await player.setPositionAsync(afterPos);
        await player.playAsync();

        await sleep(500);
        const verify = await player.getStatusAsync();
        const verifyPos = verify.isLoaded ? verify.positionMillis : afterPos;

        // 3.2 仍不推进则强制重载当前 source + 续播点
        if (verify.isLoaded && verifyPos <= afterPos && currentEpisode?.url) {
          console.warn(`[AUTOPLAY] Still stuck after frame-wakeup, reloading source at ${jumpPosition}ms`);
          await player.unloadAsync();
          await player.loadAsync(
            { uri: currentEpisode.url },
            {
              shouldPlay: true,
              positionMillis: jumpPosition,
              rate: playbackRate,
              shouldCorrectPitch: true,
            }
          );
        }
      }

      console.info(`[AUTOPLAY] Auto-play successful after onLoad`);
      usePlayerStore.setState({ isLoading: false });
      console.info(`[PERF] Video loading complete - isLoading set to false`);
    } catch (error) {
      console.warn(`[AUTOPLAY] Failed to auto-play after onLoad:`, error);
      usePlayerStore.setState({ isLoading: false });
    }
  }, [videoRef, initialPosition, introEndTime, currentEpisode?.url, playbackRate, disableInitialSeek]);

  const onLoadStart = useCallback(() => {
    if (!currentEpisode?.url) return;
    
    console.info(`[PERF] Video onLoadStart - starting to load video: ${currentEpisode.url.substring(0, 100)}...`);
    usePlayerStore.setState({ isLoading: true });
  }, [currentEpisode?.url]);

  const onError = useCallback((error: any) => {
    if (!currentEpisode?.url) return;
    
    console.error(`[ERROR] Video playback error:`, error);
    
    // 检测SSL证书错误和其他网络错误
    const errorString = (error as any)?.error?.toString() || error?.toString() || '';
    const isSSLError = errorString.includes('SSLHandshakeException') || 
                      errorString.includes('CertPathValidatorException') ||
                      errorString.includes('Trust anchor for certification path not found');
    const isNetworkError = errorString.includes('HttpDataSourceException') ||
                         errorString.includes('IOException') ||
                         errorString.includes('SocketTimeoutException');
    
    if (isSSLError) {
      console.error(`[SSL_ERROR] SSL certificate validation failed for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "SSL证书错误，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('ssl', currentEpisode.url);
    } else if (isNetworkError) {
      console.error(`[NETWORK_ERROR] Network connection failed for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "网络连接失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('network', currentEpisode.url);
    } else {
      console.error(`[VIDEO_ERROR] Other video error for URL: ${currentEpisode.url}`);
      Toast.show({ 
        type: "error", 
        text1: "视频播放失败，正在尝试其他播放源...",
        text2: "请稍候"
      });
      usePlayerStore.getState().handleVideoError('other', currentEpisode.url);
    }
  }, [currentEpisode?.url]);

  // 优化的Video组件props
  const videoProps = useMemo(() => ({
    source: { uri: currentEpisode?.url || '' },
    posterSource: { uri: detail?.poster ?? "" },
    resizeMode: ResizeMode.CONTAIN,
    rate: playbackRate,
    onPlaybackStatusUpdate: handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    useNativeControls: deviceType !== 'tv',
    shouldPlay: true,
  }), [
    currentEpisode?.url,
    detail?.poster,
    playbackRate,
    handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    deviceType,
  ]);

  return {
    onLoad,
    onLoadStart,
    onError,
    videoProps,
  };
};