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

            // Trigger download if the file is cloud-only (.icloud placeholder).
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                try? FileManager.default.startDownloadingUbiquitousItem(at: fileURL)
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
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                call.resolve()
                return
            }
            var coordinatorError: NSError?
            let coordinator = NSFileCoordinator(filePresenter: self.directoryPresenter)
            coordinator.coordinate(writingItemAt: fileURL, options: .forDeleting, error: &coordinatorError) { url in
                try? FileManager.default.removeItem(at: url)
            }
            call.resolve()
        }
    }

    /// Lists visible files in a directory inside the iCloud container.
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
                let items = try FileManager.default.contentsOfDirectory(
                    at: dirURL,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles]
                )
                let files = items.map { ["name": $0.lastPathComponent] }
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
}
