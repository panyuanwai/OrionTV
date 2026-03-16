package com.oriontv

import android.app.Activity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native module to force-kill the app process.
 * 
 * On Chromecast with Google TV, when the user presses back to exit the app,
 * the Activity is finished but the process stays alive. When the app is
 * relaunched, React Native reuses the same JS context, but the underlying
 * ExoPlayer/MediaCodec native state from the previous session is corrupted.
 * This causes video playback to freeze on a single frame.
 * 
 * BackHandler.exitApp() only calls Activity.finish() which does NOT kill
 * the process. This module provides forceKill() which calls
 * Process.killProcess() to ensure a true cold restart.
 */
class AppExitModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String {
        return "AppExit"
    }

    @ReactMethod
    fun forceKill() {
        // First finish the Activity properly
        val activity: Activity? = currentActivity
        activity?.finishAffinity()
        
        // Then kill the process to ensure complete cleanup of
        // ExoPlayer, MediaCodec, SurfaceView, and Audio session state
        android.os.Process.killProcess(android.os.Process.myPid())
        System.exit(0)
    }

    @ReactMethod
    fun finishAndRemoveTask() {
        val activity: Activity? = currentActivity
        activity?.finishAndRemoveTask()
        
        // Kill the process after a small delay to allow finishAndRemoveTask to complete
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            android.os.Process.killProcess(android.os.Process.myPid())
            System.exit(0)
        }, 200)
    }
}
