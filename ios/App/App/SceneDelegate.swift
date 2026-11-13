import UIKit
import AVFoundation
import StoreKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // Audio shared to Alchemy that launched it
        connectionOptions.urlContexts.forEach { AlchemyPlugin.receive($0.url) }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Audio shared to Alchemy while it's running
        URLContexts.forEach { AlchemyPlugin.receive($0.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// The web view, plus Alchemy's own native plugin.
class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AlchemyPlugin())
        // An app's screens don't pinch-zoom (the page's viewport says so too).
        webView?.scrollView.minimumZoomScale = 1
        webView?.scrollView.maximumZoomScale = 1
        webView?.scrollView.bouncesZoom = false
    }
}

// Alchemy's native helpers:
// - headphones: whether sound is going to headphones (wired, USB or Bluetooth),
//   where a click while recording can't leak into the microphone.
// - audio shared in from other apps (Voice Memos → Share → Alchemy, Files, Mail):
//   copied in the moment iOS hands it over (its own copy may be lent only briefly),
//   then decoded here to a short WAV the web view can read, so a long memo never
//   has to be decoded whole in the page.
// - the library: saved takes as files in Application Support, which iOS keeps
//   (and backs up), unlike web storage, which it may clear when space runs low.
// - Alchemy Pro: a one-time in-app purchase (StoreKit 2).
@objc(AlchemyPlugin)
public class AlchemyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AlchemyPlugin"
    public let jsName = "Alchemy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "headphones", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeOpenedFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "libList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "libRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "libWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "libMove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "libDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "proStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buyPro", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePro", returnType: CAPPluginReturnPromise)
    ]

    private static weak var shared: AlchemyPlugin?
    // Shared files waiting for the page to take them: (copy in tmp, display name)
    private static var pending: [(url: URL?, name: String)] = []
    private static let lock = NSLock()

    private var purchaseUpdates: Task<Void, Never>?

    override public func load() {
        AlchemyPlugin.shared = self
        // Purchases completed outside the app's own flow (Ask to Buy approved later,
        // a refund, a purchase on another device): finish them and tell the page.
        purchaseUpdates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let transaction) = result { await transaction.finish() }
                await self?.announcePro()
            }
        }
    }

    // MARK: Library files

    private static let fileQueue = DispatchQueue(label: "alchemy.library")

    private static func takesDirectory() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("Takes", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // A file in the takes folder. Names are plain (no folders), so a page can't reach elsewhere.
    private static func takeFile(_ name: String?) throws -> URL {
        guard let name = name, !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else {
            throw NSError(domain: "Alchemy", code: 10, userInfo: [NSLocalizedDescriptionKey: "Bad file name"])
        }
        return try takesDirectory().appendingPathComponent(name)
    }

    private func onFiles(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]) {
        AlchemyPlugin.fileQueue.async {
            do { call.resolve(try work()) } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func libList(_ call: CAPPluginCall) {
        onFiles(call) {
            let names = try FileManager.default.contentsOfDirectory(atPath: try AlchemyPlugin.takesDirectory().path)
            return ["names": names.filter { !$0.hasPrefix(".") && !$0.hasSuffix(".part") }]
        }
    }

    // Part of a file, base64: { data, size }. Without offset/length, the whole file.
    @objc func libRead(_ call: CAPPluginCall) {
        onFiles(call) {
            let url = try AlchemyPlugin.takeFile(call.getString("name"))
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let size = try handle.seekToEnd()
            let offset = min(UInt64(max(0, call.getInt("offset") ?? 0)), size)
            let length = min(call.getInt("length").map { UInt64(max(0, $0)) } ?? size, size - offset)
            try handle.seek(toOffset: offset)
            let data = try handle.read(upToCount: Int(length)) ?? Data()
            return ["data": data.base64EncodedString(), "size": size]
        }
    }

    // Writes (or with append, adds to) a file from base64 data.
    @objc func libWrite(_ call: CAPPluginCall) {
        onFiles(call) {
            let url = try AlchemyPlugin.takeFile(call.getString("name"))
            guard let data = Data(base64Encoded: call.getString("data") ?? "") else {
                throw NSError(domain: "Alchemy", code: 11, userInfo: [NSLocalizedDescriptionKey: "Bad data"])
            }
            if call.getBool("append") ?? false, FileManager.default.fileExists(atPath: url.path) {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } else {
                try data.write(to: url, options: .atomic)
            }
            return [:]
        }
    }

    // Renames a file, replacing any file already there (how a finished save lands).
    @objc func libMove(_ call: CAPPluginCall) {
        onFiles(call) {
            let from = try AlchemyPlugin.takeFile(call.getString("from"))
            let to = try AlchemyPlugin.takeFile(call.getString("to"))
            if FileManager.default.fileExists(atPath: to.path) {
                _ = try FileManager.default.replaceItemAt(to, withItemAt: from)
            } else {
                try FileManager.default.moveItem(at: from, to: to)
            }
            return [:]
        }
    }

    @objc func libDelete(_ call: CAPPluginCall) {
        onFiles(call) {
            let url = try AlchemyPlugin.takeFile(call.getString("name"))
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return [:]
        }
    }

    // MARK: Alchemy Pro

    static let proProduct = "com.mediavanity.alchemy.pro"

    private static func ownsPro() async -> Bool {
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productID == proProduct, t.revocationDate == nil { return true }
        }
        return false
    }

    private func announcePro() async {
        let pro = await AlchemyPlugin.ownsPro()
        DispatchQueue.main.async { self.notifyListeners("proChanged", data: ["pro": pro]) }
    }

    // { pro, price? }: whether Pro is owned, and its price in the local currency
    // when the App Store can be reached.
    @objc func proStatus(_ call: CAPPluginCall) {
        Task {
            var out: [String: Any] = ["pro": await AlchemyPlugin.ownsPro()]
            if let product = try? await Product.products(for: [AlchemyPlugin.proProduct]).first {
                out["price"] = product.displayPrice
            }
            call.resolve(out)
        }
    }

    // { pro, cancelled?, pending?, error? }
    @objc func buyPro(_ call: CAPPluginCall) {
        Task {
            do {
                guard let product = try await Product.products(for: [AlchemyPlugin.proProduct]).first else {
                    call.resolve(["pro": false, "error": "unavailable"])
                    return
                }
                switch try await product.purchase() {
                case .success(let verification):
                    if case .verified(let transaction) = verification {
                        await transaction.finish()
                        call.resolve(["pro": true])
                    } else {
                        call.resolve(["pro": false, "error": "unverified"])
                    }
                case .pending:
                    call.resolve(["pro": false, "pending": true])
                case .userCancelled:
                    call.resolve(["pro": false, "cancelled": true])
                @unknown default:
                    call.resolve(["pro": false])
                }
            } catch {
                call.resolve(["pro": false, "error": error.localizedDescription])
            }
        }
    }

    // Restore Purchases: syncs with the App Store (it may ask the user to sign in).
    @objc func restorePro(_ call: CAPPluginCall) {
        Task {
            var failed: String? = nil
            do { try await AppStore.sync() } catch { failed = error.localizedDescription }
            var out: [String: Any] = ["pro": await AlchemyPlugin.ownsPro()]
            if let failed = failed { out["error"] = failed }
            call.resolve(out)
        }
    }

    private static let headphonePorts: Set<AVAudioSession.Port> = [
        .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio
    ]

    @objc func headphones(_ call: CAPPluginCall) {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let on = outputs.contains { AlchemyPlugin.headphonePorts.contains($0.portType) }
        call.resolve(["headphones": on])
    }

    // Called by the scene for every URL it's opened with.
    static func receive(_ url: URL) {
        guard url.isFileURL else { return }
        let name = url.deletingPathExtension().lastPathComponent
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var copy: URL? = nil
        do {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Imports", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(UUID().uuidString).appendingPathExtension(url.pathExtension)
            try FileManager.default.copyItem(at: url, to: dest)
            copy = dest
            // iOS's own copy in Documents/Inbox isn't needed any more.
            if url.path.contains("/Documents/Inbox/") { try? FileManager.default.removeItem(at: url) }
        } catch {
            CAPLog.print("Alchemy: couldn't copy shared file \(url): \(error)")
        }
        lock.lock()
        pending.append((copy, name))
        lock.unlock()
        DispatchQueue.main.async { AlchemyPlugin.shared?.notifyListeners("fileOpened", data: [:]) }
    }

    // Hands over the files shared in so far, each as { name, wav (base64), truncated }
    // or { name, error }. Takes the first maxSeconds of each.
    @objc func takeOpenedFiles(_ call: CAPPluginCall) {
        let maxSeconds = call.getDouble("maxSeconds") ?? 90
        AlchemyPlugin.lock.lock()
        let items = AlchemyPlugin.pending
        AlchemyPlugin.pending.removeAll()
        AlchemyPlugin.lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async {
            var files: [[String: Any]] = []
            for item in items {
                guard let url = item.url else {
                    files.append(["name": item.name, "error": "copy"])
                    continue
                }
                do {
                    let (wav, truncated) = try AlchemyPlugin.wav(from: url, maxSeconds: maxSeconds)
                    files.append(["name": item.name, "wav": wav.base64EncodedString(), "truncated": truncated])
                } catch {
                    CAPLog.print("Alchemy: couldn't decode shared file \(url): \(error)")
                    files.append(["name": item.name, "error": "decode"])
                }
                try? FileManager.default.removeItem(at: url)
            }
            call.resolve(["files": files])
        }
    }

    // The start of an audio file as 16-bit mono WAV at its own sample rate.
    static func wav(from url: URL, maxSeconds: Double) throws -> (Data, Bool) {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let rate = format.sampleRate
        let limit = AVAudioFramePosition(rate * maxSeconds)
        let frames = AVAudioFrameCount(min(file.length, limit))
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
            throw NSError(domain: "Alchemy", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty audio"])
        }
        try file.read(into: buffer, frameCount: frames)
        let n = Int(buffer.frameLength)
        let channels = Int(format.channelCount)
        guard let data = buffer.floatChannelData else {
            throw NSError(domain: "Alchemy", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unsupported format"])
        }
        var samples = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            var s: Float = 0
            for c in 0..<channels { s += data[c][i] }
            s /= Float(channels)
            samples[i] = Int16(max(-1, min(1, s)) * 32767)
        }

        var wav = Data(capacity: 44 + n * 2)
        func put32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
        func put16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }
        let sr = UInt32(rate.rounded())
        wav.append(contentsOf: Array("RIFF".utf8)); put32(UInt32(36 + n * 2))
        wav.append(contentsOf: Array("WAVE".utf8))
        wav.append(contentsOf: Array("fmt ".utf8)); put32(16); put16(1); put16(1)
        put32(sr); put32(sr * 2); put16(2); put16(16)
        wav.append(contentsOf: Array("data".utf8)); put32(UInt32(n * 2))
        samples.withUnsafeBytes { wav.append(contentsOf: $0) }
        return (wav, file.length > limit)
    }
}
