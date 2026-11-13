import UIKit
import AVFoundation
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// The web view, plus Alchemy's own native plugin.
class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AudioRoutePlugin())
    }
}

// Tells the app whether sound is going to headphones (wired, USB or Bluetooth),
// where a click while recording can't leak into the microphone.
@objc(AudioRoutePlugin)
public class AudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoutePlugin"
    public let jsName = "AudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise)
    ]

    private static let headphonePorts: Set<AVAudioSession.Port> = [
        .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio
    ]

    @objc func current(_ call: CAPPluginCall) {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let headphones = outputs.contains { AudioRoutePlugin.headphonePorts.contains($0.portType) }
        call.resolve(["headphones": headphones])
    }
}
