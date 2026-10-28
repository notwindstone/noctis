import AVFoundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/**
 Music folders the user picked in Files (see LocalMusic.java for Android's version). An iOS
 app can't read a folder it was never given, and can't scan a media index, so this is
 folders only: the grant is a security-scoped bookmark that survives restarts, and access
 stays open while the app runs so the web view can play the files (convertFileSrc).
 */
final class LocalMusic: NSObject, UIDocumentPickerDelegate {
    private static let bookmarksKey = "noctis.musicBookmarks"
    private static let audio: Set<String> = ["mp3", "m4a", "aac", "flac", "wav", "aif", "aiff", "caf", "alac", "opus", "ogg", "oga", "mp4"]

    /// Picked folder (as the "uri" the web layer keeps) → its URL, with access open.
    private var open: [String: URL] = [:]
    private var pending: CAPPluginCall?
    private var bookmarks: [String: Data] {
        get { UserDefaults.standard.dictionary(forKey: Self.bookmarksKey) as? [String: Data] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: Self.bookmarksKey) }
    }

    func restoreFolders() {
        var kept = bookmarks
        for (uri, data) in bookmarks {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale), url.startAccessingSecurityScopedResource() else {
                continue
            }
            open[uri] = url
            if stale, let fresh = try? url.bookmarkData() { kept[uri] = fresh }
        }
        bookmarks = kept
    }

    func pick(_ call: CAPPluginCall, from controller: UIViewController) {
        pending = call
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        controller.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { pending = nil }
        guard let url = urls.first, url.startAccessingSecurityScopedResource() else {
            pending?.reject("iOS didn't grant access to that folder")
            return
        }
        guard let bookmark = try? url.bookmarkData() else {
            url.stopAccessingSecurityScopedResource()
            pending?.reject("iOS didn't grant lasting access to that folder")
            return
        }
        let uri = url.absoluteString
        open[uri]?.stopAccessingSecurityScopedResource()
        open[uri] = url
        bookmarks[uri] = bookmark
        pending?.resolve(["uri": uri, "name": url.lastPathComponent])
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pending?.reject("No folder was picked", "CANCELLED")
        pending = nil
    }

    func release(_ uri: String) {
        open.removeValue(forKey: uri)?.stopAccessingSecurityScopedResource()
        bookmarks.removeValue(forKey: uri)
    }

    func root(_ uri: String) -> URL? { open[uri] }

    /// Every audio file under `root`, with whatever tags AVFoundation reads (not Ogg or Opus).
    func scan(_ root: URL, progress: @escaping (Int) -> Void) async -> [[String: Any]] {
        var files: [[String: Any]] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return [] }
        let base = root.standardizedFileURL.path
        // nextObject(), not for-in: iterating an NSEnumerator isn't allowed in async code.
        while let url = walker.nextObject() as? URL {
            guard Self.audio.contains(url.pathExtension.lowercased()) else { continue }
            let values = try? url.resourceValues(forKeys: Set(keys))
            guard values?.isRegularFile == true else { continue }
            var path = url.standardizedFileURL.path
            if path.hasPrefix(base) { path = String(path.dropFirst(base.count)) }
            if path.hasPrefix("/") { path.removeFirst() }
            var file: [String: Any] = [
                "uri": url.absoluteString,
                "path": path,
                "mimeType": UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "audio/mpeg",
                "size": values?.fileSize ?? 0,
                "modified": Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
            ]
            file.merge(await Self.tags(url)) { _, new in new }
            files.append(file)
            if files.count % 25 == 0 { progress(files.count) }
        }
        progress(files.count)
        return files
    }

    private static func string(_ items: [AVMetadataItem], _ identifiers: [AVMetadataIdentifier]) async -> String? {
        for identifier in identifiers {
            for item in AVMetadataItem.metadataItems(from: items, filteredByIdentifier: identifier) {
                if let value = try? await item.load(.stringValue), !value.isEmpty { return value }
            }
        }
        return nil
    }

    private static func tags(_ url: URL) async -> [String: Any] {
        let asset = AVURLAsset(url: url)
        guard let metadata = try? await asset.load(.metadata) else { return [:] }
        var tags: [String: Any] = [:]
        if let duration = try? await asset.load(.duration), duration.isNumeric, duration.seconds > 0 {
            tags["durationMs"] = Int(duration.seconds * 1000)
        }
        if let value = await string(metadata, [.commonIdentifierTitle]) { tags["title"] = value }
        if let value = await string(metadata, [.commonIdentifierArtist]) { tags["artist"] = value }
        if let value = await string(metadata, [.commonIdentifierAlbumName]) { tags["album"] = value }
        if let value = await string(metadata, [.iTunesMetadataAlbumArtist, .id3MetadataBand]) { tags["albumArtist"] = value }
        if let value = await string(metadata, [.quickTimeMetadataGenre, .iTunesMetadataUserGenre, .id3MetadataContentType]) { tags["genre"] = value }
        // ID3 writes "3/12" (or "1/2" for the disc).
        if let value = await string(metadata, [.id3MetadataTrackNumber]), let track = Int(value.split(separator: "/")[0]) { tags["track"] = track }
        if let value = await string(metadata, [.id3MetadataPartOfASet]), let disc = Int(value.split(separator: "/")[0]) { tags["disc"] = disc }
        if let value = await string(metadata, [.id3MetadataYear, .commonIdentifierCreationDate]), let year = Int(value.prefix(4)) { tags["year"] = year }
        tags["hasArtwork"] = !AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: .commonIdentifierArtwork).isEmpty
        return tags
    }

    /// The embedded cover as a small data: URL (one per album is kept, so size matters).
    static func artwork(_ url: URL) async -> String? {
        guard let metadata = try? await AVURLAsset(url: url).load(.metadata),
              let item = AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: .commonIdentifierArtwork).first,
              let data = try? await item.load(.dataValue), let image = UIImage(data: data) else { return nil }
        let longest: CGFloat = 512
        let scale = min(1, longest / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let scaled = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.85) { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return "data:image/jpeg;base64," + scaled.base64EncodedString()
    }
}

extension NoctisPlugin {
    // Reading a picked folder needs no permission; there is nothing else to ask for.
    @objc func checkMusicPermission(_ call: CAPPluginCall) { call.resolve(["state": "granted"]) }
    @objc func requestMusicPermission(_ call: CAPPluginCall) { call.resolve(["state": "granted"]) }

    // iOS has no media index an app can read songs from (src/local/library.ts only asks on Android).
    @objc func scanMediaStore(_ call: CAPPluginCall) { call.resolve(["files": [Any]()]) }

    @objc func pickMusicFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController else {
                call.reject("The app isn't ready")
                return
            }
            self.music.pick(call, from: controller)
        }
    }

    @objc func scanMusicFolder(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), let root = music.root(uri) else {
            call.reject("That folder isn't available any more; add it again")
            return
        }
        Task {
            let files = await music.scan(root) { count in
                self.notifyListeners("musicScanProgress", data: ["uri": uri, "count": count])
            }
            call.resolve(["files": files])
        }
    }

    @objc func getLocalArtwork(_ call: CAPPluginCall) {
        guard let url = call.getString("uri").flatMap(URL.init(string:)) else {
            call.reject("uri is required")
            return
        }
        Task {
            call.resolve(["dataUrl": await LocalMusic.artwork(url) ?? NSNull()])
        }
    }

    @objc func releaseMusicFolder(_ call: CAPPluginCall) {
        if let uri = call.getString("uri") { music.release(uri) }
        call.resolve()
    }
}
