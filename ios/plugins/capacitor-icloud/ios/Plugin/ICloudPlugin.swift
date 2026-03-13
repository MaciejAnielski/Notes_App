import Foundation
import Capacitor

/// File presenter for the Notes App directory inside the iCloud container.
/// Registering as a file presenter ensures the iCloud daemon (bird/cloudd)
/// is properly notified when we write files, so changes are uploaded
/// promptly.  Without this, iOS may delay or skip uploading changes made
/// by our app because the daemon is not aware a coordinated writer exists.
private class NotesDirectoryPresenter: NSObject, NSFilePresenter {
    let presentedItemURL: URL?
    let presentedItemOperationQueue = OperationQueue()

    init(url: URL) {
        self.presentedItemURL = url
        super.init()
        presentedItemOperationQueue.qualityOfService = .utility
    }

    // We don't need to react to external changes in the plugin itself (the
    // JS layer polls for changes), but implementing the protocol satisfies
    // the iCloud daemon's expectations for coordinated file access.
    func presentedItemDidChange() {}
    func presentedSubitemDidChange(at url: URL) {}
}

/// Native Capacitor plugin that provides true iCloud Documents access via
/// FileManager.url(forUbiquityContainerIdentifier:).
///
/// The @capacitor/filesystem plugin does not define Directory.ICloudDocuments,
/// so any code that falls back on that constant always uses the local Documents
/// sandbox instead of iCloud.  This plugin resolves the real iCloud container
/// URL at runtime and performs all file I/O there.
///
/// Xcode requirements (same as before):
///   1. Enable the "iCloud" capability.
///   2. Enable "iCloud Documents" (not CloudKit).
///   3. Container identifier: iCloud.com.notesapp.ios
@objc(ICloudPlugin)
public class ICloudPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ICloudPlugin"
    public let jsName = "ICloudPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getContainerPath",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir",             returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeBinaryFile",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readBinaryFile",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename",            returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rmdir",             returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Private helpers

    /// File presenter registered with NSFileCoordinator to ensure the iCloud
    /// daemon is aware of our file operations.
    private var directoryPresenter: NotesDirectoryPresenter?

    /// Returns the iCloud container Documents URL, or nil when iCloud is not
    /// configured or the device is not signed in to iCloud.
    ///
    /// FileManager.url(forUbiquityContainerIdentifier:) must be called on a
    /// background thread; calling it on the main thread can block the UI.
    private func containerDocumentsURL() -> URL? {
        guard let docs = FileManager.default
            .url(forUbiquityContainerIdentifier: "iCloud.com.notesapp.ios")?
            .appendingPathComponent("Documents") else {
            return nil
        }
        // Register a file presenter for the Notes App subdirectory on first
        // access so the iCloud daemon properly tracks our coordinated writes.
        if directoryPresenter == nil {
            let notesDir = docs.appendingPathComponent("000_Notes")
            try? FileManager.default.createDirectory(at: notesDir, withIntermediateDirectories: true)
            // Also create backup and export directories
            let backupsDir = docs.appendingPathComponent("001_Backups")
            try? FileManager.default.createDirectory(at: backupsDir, withIntermediateDirectories: true)
            let exportsDir = docs.appendingPathComponent("002_Exports")
            try? FileManager.default.createDirectory(at: exportsDir, withIntermediateDirectories: true)
            // Migrate from old "Notes App" folder if it exists
            let oldDir = docs.appendingPathComponent("Notes App")
            if FileManager.default.fileExists(atPath: oldDir.path) {
                if let files = try? FileManager.default.contentsOfDirectory(at: oldDir, includingPropertiesForKeys: nil) {
                    for file in files where file.pathExtension == "md" {
                        let dest = notesDir.appendingPathComponent(file.lastPathComponent)
                        if !FileManager.default.fileExists(atPath: dest.path) {
                            try? FileManager.default.moveItem(at: file, to: dest)
                        }
                    }
                }
            }
            let presenter = NotesDirectoryPresenter(url: notesDir)
            NSFileCoordinator.addFilePresenter(presenter)
            directoryPresenter = presenter
        }
        return docs
    }

    private func resolve(_ call: CAPPluginCall, on queue: DispatchQueue = .global(qos: .userInitiated), block: @escaping () -> Void) {
        queue.async(execute: block)
    }

    // MARK: - Plugin methods

    /// Returns `{ available: true }` when the iCloud container is reachable.
    @objc func isAvailable(_ call: CAPPluginCall) {
        resolve(call) {
            let available = self.containerDocumentsURL() != nil
            call.resolve(["available": available])
        }
    }

    /// Returns `{ path: String }` — the full filesystem path to the iCloud
    /// container Documents directory.  Useful for debugging sync issues.
    @objc func getContainerPath(_ call: CAPPluginCall) {
        resolve(call) {
            let path = self.containerDocumentsURL()?.path ?? "(nil — iCloud not available)"
            call.resolve(["path": path])
        }
    }

    /// Wait for a file to be fully downloaded from iCloud, with a timeout.
    /// Always requests the latest version from iCloud so that already-cached
    /// files that have a newer cloud version are also updated before reading.
    /// Returns true if the file is present and not actively downloading.
    private func waitForDownload(at url: URL, timeout: TimeInterval = 10.0) -> Bool {
        // Always request the latest version. For cloud-only placeholders this
        // triggers the initial download. For already-cached files this tells
        // iCloud to deliver any pending newer version from the cloud.
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)

        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if FileManager.default.fileExists(atPath: url.path) {
                // File is present locally. Check whether iCloud is still
                // actively writing a newer version into place.
                if let values = try? url.resourceValues(forKeys: [.ubiquitousItemIsDownloadingKey]),
                   values.ubiquitousItemIsDownloading == true {
                    // A newer version is actively being downloaded — wait for it.
                    Thread.sleep(forTimeInterval: 0.25)
                    continue
                }
                return true
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline

        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Returns true if this URL is a cloud-only iCloud placeholder
    /// (i.e. a ".filename.icloud" file exists instead of the real file).
    private func isCloudOnlyPlaceholder(at url: URL) -> Bool {
        let name = url.lastPathComponent
        let placeholder = url.deletingLastPathComponent()
            .appendingPathComponent(".\(name).icloud")
        return FileManager.default.fileExists(atPath: placeholder.path)
    }

    /// Returns the actual on-disk URL for a file that may be stored as a
    /// cloud-only placeholder.  If the real file exists, returns it as-is.
    /// If only the ".filename.icloud" placeholder exists, returns that URL
    /// instead so callers can perform coordinated moves/deletes on it.
    /// Returns nil when neither the file nor a placeholder is found.
    private func resolveActualURL(for url: URL) -> URL? {
        if FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        let name = url.lastPathComponent
        let placeholder = url.deletingLastPathComponent()
            .appendingPathComponent(".\(name).icloud")
        if FileManager.default.fileExists(atPath: placeholder.path) {
            return placeholder
        }
        return nil
    }

    /// Reads a UTF-8 file relative to the iCloud container Documents folder.
    /// Uses NSFileCoordinator to ensure cloud-only files are downloaded first.
    /// Call parameters:
    ///   - path (String, required): relative path inside the container, e.g. "Notes App/foo.md"
    /// Resolves `{ data: String }` on success.
    @objc func readFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let fileURL = base.appendingPathComponent(path)

            // Ensure we have the latest version from iCloud before reading.
            if !self.waitForDownload(at: fileURL) {
                // Distinguish a genuine deletion from a download timeout so
                // the JS layer can show the right error to the user.
                if self.isCloudOnlyPlaceholder(at: fileURL) {
                    call.reject("Download timed out: \(path)")
                } else {
                    call.reject("File not found: \(path)")
                }
                return
            }

            var coordinatorError: NSError?
            var content: String?
            var readError: Error?
            let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
            coordinator.coordinate(readingItemAt: fileURL, options: [], error: &coordinatorError) { url in
                do {
                    content = try String(contentsOf: url, encoding: .utf8)
                } catch {
                    readError = error
                }
            }
            if let err = coordinatorError ?? readError {
                call.reject("File not found: \(path)", nil, err)
            } else {
                call.resolve(["data": content ?? ""])
            }
        }
    }

    /// Writes a UTF-8 file relative to the iCloud container Documents folder.
    /// Intermediate directories are created automatically.
    /// Uses NSFileCoordinator so the iCloud daemon is notified of changes.
    /// Call parameters:
    ///   - path (String, required): relative path inside the container
    ///   - data (String, required): file content
    @objc func writeFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path"),
              let data = call.getString("data") else {
            call.reject("path and data are required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let fileURL = base.appendingPathComponent(path)
            do {
                let dir = fileURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

                var coordinatorError: NSError?
                var writeError: Error?
                // Pass the directory presenter so NSFileCoordinator notifies
                // the iCloud daemon that a registered presenter is writing.
                let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
                coordinator.coordinate(writingItemAt: fileURL, options: .forReplacing, error: &coordinatorError) { url in
                    do {
                        try data.write(to: url, atomically: true, encoding: .utf8)
                    } catch {
                        writeError = error
                    }
                }
                if let err = coordinatorError ?? writeError {
                    throw err
                }
                call.resolve()
            } catch {
                call.reject("Write failed: \(path)", nil, error)
            }
        }
    }

    /// Deletes a file from the iCloud container.  Resolves even if the file
    /// does not exist.  Uses NSFileCoordinator so the iCloud daemon is notified.
    /// Call parameters:
    ///   - path (String, required): relative path inside the container
    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let fileURL = base.appendingPathComponent(path)
            // resolveActualURL handles both fully-downloaded files and
            // cloud-only ".filename.icloud" placeholders.  Without this,
            // deleting a note that has never been downloaded would silently
            // succeed without removing the placeholder, causing the note to
            // reappear in the list on the next poll.
            guard let actualURL = self.resolveActualURL(for: fileURL) else {
                call.resolve()
                return
            }
            var coordinatorError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
            coordinator.coordinate(writingItemAt: actualURL, options: .forDeleting, error: &coordinatorError) { url in
                try? FileManager.default.removeItem(at: url)
            }
            call.resolve()
        }
    }

    /// Lists files in a directory inside the iCloud container.
    /// Includes cloud-only files by stripping `.icloud` placeholder naming
    /// so the JS layer sees the real filenames regardless of download state.
    /// Call parameters:
    ///   - path (String, required): relative path to the directory
    /// Resolves `{ files: [{ name: String }] }`.
    @objc func readdir(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let dirURL = base.appendingPathComponent(path)
            do {
                // Do NOT skip hidden files — iCloud placeholders are hidden
                // files named ".filename.icloud".
                let items = try FileManager.default.contentsOfDirectory(
                    at: dirURL,
                    includingPropertiesForKeys: nil,
                    options: []
                )
                var seen = Set<String>()
                var files: [[String: String]] = []
                for item in items {
                    var name = item.lastPathComponent
                    // Skip macOS metadata files
                    if name == ".DS_Store" { continue }
                    // Convert iCloud placeholder names: ".foo.txt.icloud" → "foo.txt"
                    if name.hasPrefix(".") && name.hasSuffix(".icloud") {
                        name = String(name.dropFirst(1).dropLast(7))  // remove leading "." and trailing ".icloud"
                    }
                    if name.isEmpty || name.hasPrefix(".") { continue }
                    if seen.insert(name).inserted {
                        files.append(["name": name])
                    }
                }
                call.resolve(["files": files])
            } catch {
                call.reject("Cannot read directory: \(path)", nil, error)
            }
        }
    }

    /// Creates a directory (including intermediate directories) inside the
    /// iCloud container.  Resolves even if the directory already exists.
    /// Call parameters:
    ///   - path (String, required): relative path to the directory
    @objc func mkdir(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let dirURL = base.appendingPathComponent(path)
            try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
            call.resolve()
        }
    }

    /// Writes a binary file from base64-encoded data.
    /// Call parameters:
    ///   - path (String, required): relative path inside the container
    ///   - data (String, required): base64-encoded binary data
    @objc func writeBinaryFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path"),
              let base64Data = call.getString("data") else {
            call.reject("path and data are required")
            return
        }
        guard let binaryData = Data(base64Encoded: base64Data) else {
            call.reject("Invalid base64 data")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let fileURL = base.appendingPathComponent(path)
            do {
                let dir = fileURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                var coordinatorError: NSError?
                var writeError: Error?
                let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
                coordinator.coordinate(writingItemAt: fileURL, options: .forReplacing, error: &coordinatorError) { url in
                    do {
                        try binaryData.write(to: url, options: .atomic)
                    } catch {
                        writeError = error
                    }
                }
                if let err = coordinatorError ?? writeError {
                    throw err
                }
                call.resolve()
            } catch {
                call.reject("Write failed: \(path)", nil, error)
            }
        }
    }

    /// Reads a binary file and returns its contents as base64-encoded data.
    /// Uses NSFileCoordinator and waits for cloud-only file downloads.
    /// Call parameters:
    ///   - path (String, required): relative path inside the container
    /// Resolves `{ data: String }` (base64) on success.
    @objc func readBinaryFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let fileURL = base.appendingPathComponent(path)

            // Wait for download if the file is cloud-only.
            if !self.waitForDownload(at: fileURL) {
                call.reject("File not found: \(path)")
                return
            }

            var coordinatorError: NSError?
            var fileData: Data?
            var readError: Error?
            let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
            coordinator.coordinate(readingItemAt: fileURL, options: [], error: &coordinatorError) { url in
                do {
                    fileData = try Data(contentsOf: url)
                } catch {
                    readError = error
                }
            }
            if let err = coordinatorError ?? readError {
                call.reject("File not found: \(path)", nil, err)
            } else {
                call.resolve(["data": fileData?.base64EncodedString() ?? ""])
            }
        }
    }

    /// Renames (moves) a file or directory within the iCloud container.
    /// Handles cloud-only ".filename.icloud" placeholders: when the source
    /// file has not been downloaded yet the placeholder is moved instead,
    /// which iCloud correctly treats as a coordinated move operation.
    /// Call parameters:
    ///   - oldPath (String, required): current relative path
    ///   - newPath (String, required): desired relative path
    @objc func rename(_ call: CAPPluginCall) {
        guard let oldPath = call.getString("oldPath"),
              let newPath = call.getString("newPath") else {
            call.reject("oldPath and newPath are required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let srcURL = base.appendingPathComponent(oldPath)
            let dstURL = base.appendingPathComponent(newPath)
            do {
                let dstDir = dstURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: dstDir, withIntermediateDirectories: true)

                // Resolve the actual source: a real file or a cloud-only
                // placeholder.  Without this, trashNote() for a note that has
                // never been downloaded would fail silently (moveItem throws
                // because foo.md doesn't exist, only .foo.md.icloud does),
                // causing the deleted note to reappear on the next poll.
                guard let actualSrcURL = self.resolveActualURL(for: srcURL) else {
                    call.reject("Source file not found: \(oldPath)")
                    return
                }

                // When moving a placeholder (.foo.md.icloud), the destination
                // must also use the placeholder name so iCloud tracks the move.
                let actualDstURL: URL
                if actualSrcURL == srcURL {
                    actualDstURL = dstURL
                } else {
                    let dstName = dstURL.lastPathComponent
                    actualDstURL = dstURL.deletingLastPathComponent()
                        .appendingPathComponent(".\(dstName).icloud")
                }

                var coordinatorError: NSError?
                var moveError: Error?
                let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
                coordinator.coordinate(writingItemAt: actualSrcURL, options: .forMoving,
                                       writingItemAt: actualDstURL, options: .forReplacing,
                                       error: &coordinatorError) { src, dst in
                    do {
                        try FileManager.default.moveItem(at: src, to: dst)
                    } catch {
                        moveError = error
                    }
                }
                if let err = coordinatorError ?? moveError {
                    throw err
                }
                call.resolve()
            } catch {
                call.reject("Rename failed", nil, error)
            }
        }
    }

    /// Removes a directory (optionally recursively) from the iCloud container.
    /// Call parameters:
    ///   - path (String, required): relative path to the directory
    ///   - recursive (Bool, optional): if true, remove contents too (default false)
    @objc func rmdir(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("path is required")
            return
        }
        resolve(call) {
            guard let base = self.containerDocumentsURL() else {
                call.reject("iCloud container not available")
                return
            }
            let dirURL = base.appendingPathComponent(path)
            guard FileManager.default.fileExists(atPath: dirURL.path) else {
                call.resolve()
                return
            }
            var coordinatorError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
            coordinator.coordinate(writingItemAt: dirURL, options: .forDeleting, error: &coordinatorError) { url in
                try? FileManager.default.removeItem(at: url)
            }
            call.resolve()
        }
    }
}
