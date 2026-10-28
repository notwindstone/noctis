import AVFoundation
import Capacitor
import MediaPlayer
import UIKit
import UserNotifications

/// The iOS half of `Noctis` in src/native.ts; the Android half is NoctisPlugin.java.
/// Sign-in windows are in WebSignIn.swift, local music in LocalMusic.swift.
@objc(NoctisPlugin)
public class NoctisPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    public let identifier = "NoctisPlugin"
    public let jsName = "Noctis"
    public let pluginMethods: [CAPPluginMethod] = [
        "setBackEnabled", "getSystemColors", "haptic", "setKeepAwake",
        "updateMediaSession", "clearMediaSession",
        "checkNotificationPermission", "requestNotificationPermission", "showNotification", "closeNotification",
        "openLogin", "openAuth", "openCookieLogin", "captureResponse", "clearCookies",
        "checkMusicPermission", "requestMusicPermission", "scanMediaStore",
        "pickMusicFolder", "scanMusicFolder", "getLocalArtwork", "releaseMusicFolder",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private static weak var instance: NoctisPlugin?
    /// A file opened before the web layer was listening (a cold start from Files).
    private static var pendingFiles: [URL] = []

    let music = LocalMusic()

    override public func load() {
        NoctisPlugin.instance = self
        UNUserNotificationCenter.current().delegate = self
        // Playing in the background and with the silent switch on needs the playback category.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        music.restoreFolders()
        configureRemoteCommands()
        for url in NoctisPlugin.pendingFiles { readOpenedFile(url) }
        NoctisPlugin.pendingFiles = []
    }

    /* ---------------- Things Android needs the plugin for and iOS does itself ---------------- */

    // The system edge-swipe is the web layer's (see back.ts): there's no predictive back to drive.
    @objc func setBackEnabled(_ call: CAPPluginCall) { call.resolve() }

    // No Material You; the theme falls back to its own accent.
    @objc func getSystemColors(_ call: CAPPluginCall) { call.resolve() }

    // Audio in the background keeps the app alive; there is no wake lock to hold.
    @objc func setKeepAwake(_ call: CAPPluginCall) { call.resolve() }

    @objc func haptic(_ call: CAPPluginCall) {
        let type = call.getString("type") ?? "tap"
        DispatchQueue.main.async {
            switch type {
            case "press", "dragStart": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "longPress": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            case "toggleOn", "thresholdOn": UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
            case "toggleOff", "thresholdOff", "gestureEnd": UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            case "tick": UISelectionFeedbackGenerator().selectionChanged()
            case "confirm": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "reject": UINotificationFeedbackGenerator().notificationOccurred(.error)
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            call.resolve()
        }
    }

    /* ---------------- Lock screen controls ---------------- */

    private var mediaState: [String: Any] = [:]
    private var artworkURL: String?
    private var artwork: MPMediaItemArtwork?
    private var commandsReady = false

    @objc func updateMediaSession(_ call: CAPPluginCall) {
        let playing = call.getBool("playing") ?? false
        let info: [String: Any] = [
            MPMediaItemPropertyTitle: call.getString("title") ?? "",
            MPMediaItemPropertyArtist: call.getString("artist") ?? "",
            MPMediaItemPropertyAlbumTitle: call.getString("album") ?? "",
            MPMediaItemPropertyPlaybackDuration: call.getDouble("duration") ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: call.getDouble("position") ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        mediaState = info
        mediaState["playing"] = playing
        let commands = MPRemoteCommandCenter.shared()
        let previous = call.getBool("hasPrevious") ?? false
        let next = call.getBool("hasNext") ?? false
        let source = call.getString("artwork")
        DispatchQueue.main.async {
            try? AVAudioSession.sharedInstance().setActive(true)
            commands.previousTrackCommand.isEnabled = previous
            commands.nextTrackCommand.isEnabled = next
            let center = MPNowPlayingInfoCenter.default()
            var merged = info
            if source == self.artworkURL, let art = self.artwork { merged[MPMediaItemPropertyArtwork] = art }
            center.nowPlayingInfo = merged
            center.playbackState = playing ? .playing : .paused
            if source != self.artworkURL { self.loadArtwork(source) }
        }
        call.resolve()
    }

    @objc func clearMediaSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            self.artworkURL = nil
            self.artwork = nil
        }
        call.resolve()
    }

    /// http(s) and data: artwork; anything else (blob:, capacitor://) the system can't use.
    private func loadArtwork(_ source: String?) {
        artworkURL = source
        artwork = nil
        guard let source, let url = URL(string: source) else { return }
        Task {
            let data: Data?
            if url.scheme == "data" { data = try? Data(contentsOf: url) }
            else if url.scheme == "https" || url.scheme == "http" { data = try? await URLSession.shared.data(from: url).0 }
            else { data = nil }
            guard let data, let image = UIImage(data: data), self.artworkURL == source else { return }
            let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.artwork = art
            await MainActor.run {
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
    }

    private func configureRemoteCommands() {
        guard !commandsReady else { return }
        commandsReady = true
        let commands = MPRemoteCommandCenter.shared()
        func action(_ name: String, _ command: MPRemoteCommand) {
            command.addTarget { [weak self] _ in
                self?.notifyListeners("mediaAction", data: ["action": name])
                return .success
            }
        }
        action("play", commands.playCommand)
        action("pause", commands.pauseCommand)
        action("next", commands.nextTrackCommand)
        action("previous", commands.previousTrackCommand)
        action("stop", commands.stopCommand)
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            let playing = self?.mediaState["playing"] as? Bool ?? false
            self?.notifyListeners("mediaAction", data: ["action": playing ? "pause" : "play"])
            return .success
        }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.notifyListeners("mediaAction", data: ["action": "seek", "position": event.positionTime])
            return .success
        }
    }

    /* ---------------- Notifications ---------------- */

    private func permissionState(_ settings: UNNotificationSettings) -> String {
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    @objc func checkNotificationPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["state": self.permissionState(settings)])
        }
    }

    @objc func requestNotificationPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            call.resolve(["state": granted ? "granted" : "denied"])
        }
    }

    @objc func showNotification(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let title = call.getString("title") else {
            call.reject("id and title are required")
            return
        }
        let quiet = call.getBool("quiet") ?? false
        let content = UNMutableNotificationContent()
        content.title = title
        var body = call.getString("body") ?? ""
        // There are no progress bars in iOS notifications.
        if let progress = call.getDouble("progress"), call.getBool("indeterminate") != true {
            body += (body.isEmpty ? "" : " · ") + "\(Int((progress * 100).rounded()))%"
        }
        content.body = body
        content.userInfo = ["id": id]
        if !quiet { content.sound = .default }
        content.interruptionLevel = quiet ? .passive : .active

        let actions = (call.getArray("actions", JSObject.self) ?? []).compactMap { item -> UNNotificationAction? in
            guard let actionId = item["id"] as? String, let label = item["label"] as? String else { return nil }
            return UNNotificationAction(identifier: actionId, title: label, options: [])
        }
        let center = UNUserNotificationCenter.current()
        if !actions.isEmpty {
            // Categories are global; one per notification id keeps their buttons apart.
            let category = UNNotificationCategory(identifier: "noctis.\(id)", actions: actions, intentIdentifiers: [])
            center.getNotificationCategories { existing in
                center.setNotificationCategories(existing.filter { $0.identifier != category.identifier }.union([category]))
            }
            content.categoryIdentifier = category.identifier
        }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { call.reject(error.localizedDescription) } else { call.resolve() }
        }
    }

    @objc func closeNotification(_ call: CAPPluginCall) {
        if let id = call.getString("id") {
            let center = UNUserNotificationCenter.current()
            center.removeDeliveredNotifications(withIdentifiers: [id])
            center.removePendingNotificationRequests(withIdentifiers: [id])
        }
        call.resolve()
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The web layer decides when to show one (only in the background, for downloads).
        completionHandler(notification.request.content.interruptionLevel == .passive ? [.list] : [.banner, .list, .sound])
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let id = response.notification.request.content.userInfo["id"] as? String {
            let action = response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "click" : response.actionIdentifier
            notifyListeners("notificationAction", data: ["id": id, "action": action], retainUntilConsumed: true)
        }
        completionHandler()
    }

    /* ---------------- Opened files ---------------- */

    /// A .noctis plugin opened from Files, Safari or a chat app.
    static func open(_ url: URL) {
        if let plugin = instance { plugin.readOpenedFile(url) } else { pendingFiles.append(url) }
    }

    /// Plugin archives are a few MB at most; anything far bigger isn't one.
    private static let maxOpenedBytes = 32 * 1024 * 1024

    private func readOpenedFile(_ url: URL) {
        DispatchQueue.global().async {
            var event: [String: Any] = ["name": url.lastPathComponent]
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                if size > NoctisPlugin.maxOpenedBytes { throw CocoaError(.fileReadTooLarge) }
                event["data"] = try Data(contentsOf: url).base64EncodedString()
            } catch {
                event["error"] = "The file couldn't be read"
            }
            self.notifyListeners("openFile", data: event, retainUntilConsumed: true)
        }
    }
}
