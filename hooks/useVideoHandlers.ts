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

      const resumePosition = Math.max(0, initialPosition || introEndTime || 0);

      // 先从0起播，避免直接seek到历史点导致Chromecast卡首帧
      await player.playAsync();
      await sleep(500);

      let status = await player.getStatusAsync();
      if (!status.isLoaded) {
        throw new Error('status not loaded after initial play');
      }

      // 延迟跳转到续播点
      if (resumePosition > 0) {
        await player.setPositionAsync(resumePosition);
        await player.playAsync();
      }

      // 检查是否真正推进
      const before = await player.getStatusAsync();
      const beforePos = before.isLoaded ? before.positionMillis : 0;
      await sleep(900);
      const after = await player.getStatusAsync();
      const afterPos = after.isLoaded ? after.positionMillis : 0;

      const stuck = before.isLoaded && after.isLoaded && afterPos <= beforePos;
      if (stuck && currentEpisode?.url) {
        console.warn(`[AUTOPLAY] Position stuck (${afterPos}), forcing one cold reload`);

        await player.unloadAsync();
        await player.loadAsync(
          { uri: currentEpisode.url },
          {
            shouldPlay: true,
            positionMillis: 0,
            rate: playbackRate,
            shouldCorrectPitch: true,
          }
        );

        await sleep(500);

        if (resumePosition > 0) {
          await player.setPositionAsync(resumePosition);
          await player.playAsync();
        }
      }

      usePlayerStore.setState({ isLoading: false });
      console.info(`[PERF] Video loading complete - isLoading set to false`);
    } catch (error) {
      console.warn(`[AUTOPLAY] Failed to auto-play after onLoad:`, error);
      usePlayerStore.setState({ isLoading: false });
    }
  }, [videoRef, initialPosition, introEndTime, currentEpisode?.url, playbackRate]);

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
