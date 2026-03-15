import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Platform, View, StyleSheet, BackHandler } from "react-native";
import Toast from "react-native-toast-message";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useSettingsStore } from "@/stores/settingsStore";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import LoginModal from "@/components/LoginModal";
import useAuthStore from "@/stores/authStore";
import { useUpdateStore, initUpdateStore } from "@/stores/updateStore";
import { UpdateModal } from "@/components/UpdateModal";
import { UPDATE_CONFIG } from "@/constants/UpdateConfig";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('RootLayout');

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = "dark";
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });
  const { loadSettings, remoteInputEnabled, apiBaseUrl } = useSettingsStore();
  const { startServer, stopServer } = useRemoteControlStore();
  const { checkLoginStatus } = useAuthStore();
  const { checkForUpdate, lastCheckTime } = useUpdateStore();
  const responsiveConfig = useResponsiveLayout();

  useEffect(() => {
    const initializeApp = async () => {
      await loadSettings();
    };
    initializeApp();
    initUpdateStore(); // 初始化更新存储
  }, [loadSettings]);

  useEffect(() => {
    if (apiBaseUrl) {
      checkLoginStatus(apiBaseUrl);
    }
  }, [apiBaseUrl, checkLoginStatus]);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
      if (error) {
        logger.warn(`Error in loading fonts: ${error}`);
      }
    }
  }, [loaded, error]);

  // 检查更新
  useEffect(() => {
    if (loaded && UPDATE_CONFIG.AUTO_CHECK && Platform.OS === 'android') {
      // 检查是否需要自动检查更新
      const shouldCheck = Date.now() - lastCheckTime > UPDATE_CONFIG.CHECK_INTERVAL;
      if (shouldCheck) {
        checkForUpdate(true); // 静默检查
      }
    }
  }, [loaded, lastCheckTime, checkForUpdate]);

  useEffect(() => {
    // 只有在非手机端才启动远程控制服务器
    if (remoteInputEnabled && responsiveConfig.deviceType !== "mobile") {
      startServer();
    } else {
      stopServer();
    }
  }, [remoteInputEnabled, startServer, stopServer, responsiveConfig.deviceType]);

  // 关键修复: 在 TV 设备的根路由上按返回键时，完全退出 app（杀掉进程）
  // 这可以防止 ExoPlayer 的 MediaCodec 状态在进程复用时被损坏
  // 这也是 Android TV 的标准 UX — 在主界面按返回应该退出应用
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const backAction = () => {
      // 这个 handler 的优先级最低（在 _layout.tsx 中注册）
      // 只有当没有其他页面的 BackHandler 响应时才会执行
      // 即用户已经在根路由上
      logger.info('[ROOT_BACK] User pressed back at root - exiting app to prevent stale ExoPlayer state');
      BackHandler.exitApp();
      return true;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, []);

  if (!loaded && !error) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <View style={styles.container}>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="detail" options={{ headerShown: false }} />
            {Platform.OS !== "web" && <Stack.Screen name="play" options={{ headerShown: false }} />}
            <Stack.Screen name="search" options={{ headerShown: false }} />
            <Stack.Screen name="live" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ headerShown: false }} />
            <Stack.Screen name="favorites" options={{ headerShown: false }} />
            <Stack.Screen name="+not-found" />
          </Stack>
        </View>
        <Toast />
        <LoginModal />
        <UpdateModal />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
