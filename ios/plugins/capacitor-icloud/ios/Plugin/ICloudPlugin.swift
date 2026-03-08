import Foundation
import Capacitor

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
        CAPPluginMethod(name: "isAvailable",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readdir",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir",        returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Private helpers

    /// Returns the iCloud container Documents URL, or nil when iCloud is not
    /// configured or the device is not signed in to iCloud.
    ///
    /// FileManager.url(forUbiquityContainerIdentifier:) must be called on a
    /// background thread; calling it on the main thread can block the UI.
    private func containerDocumentsURL() -> URL? {
        FileManager.default
            .url(forUbiquityContainerIdentifier: "iCloud.com.notesapp.ios")?
            .appendingPathComponent("Documents")
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

    /// Reads a UTF-8 file relative to the iCloud container Documents folder.
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
            do {
                let content = try String(contentsOf: fileURL, encoding: .utf8)
                call.resolve(["data": content])
            } catch {
                call.reject("File not found: \(path)", nil, error)
            }
        }
    }

    /// Writes a UTF-8 file relative to the iCloud container Documents folder.
    /// Intermediate directories are created automatically.
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
                try data.write(to: fileURL, atomically: true, encoding: .utf8)
                call.resolve()
            } catch {
                call.reject("Write failed: \(path)", nil, error)
            }
        }
    }

    /// Deletes a file from the iCloud container.  Resolves even if the file
    /// does not exist.
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
            try? FileManager.default.removeItem(at: fileURL)
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
