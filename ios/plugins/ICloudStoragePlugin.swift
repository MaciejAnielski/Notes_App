import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers

/// Native Capacitor plugin that provides iCloud Drive file I/O for notes.
///
/// Uses NSFileManager's ubiquity container API to read/write .md files in
/// the app's iCloud Drive container (iCloud.com.notesapp.ios).
///
/// Xcode setup required:
///   1. Target → Signing & Capabilities → + Capability → iCloud
///   2. Check "iCloud Documents"
///   3. Add container: iCloud.com.notesapp.ios
@objc(ICloudStoragePlugin)
public class ICloudStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudStoragePlugin"
    public let jsName = "ICloudStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFilesLocation", returnType: CAPPluginReturnPromise)
    ]

    private let containerID = "iCloud.com.notesapp.ios"

    /// Returns the iCloud Documents directory URL, or nil if iCloud is unavailable.
    private func iCloudDocumentsURL() -> URL? {
        guard let containerURL = FileManager.default.url(forUbiquityContainerIdentifier: containerID) else {
            return nil
        }
        let documentsURL = containerURL.appendingPathComponent("Documents")
        if !FileManager.default.fileExists(atPath: documentsURL.path) {
            try? FileManager.default.createDirectory(at: documentsURL, withIntermediateDirectories: true)
        }
        return documentsURL
    }

    /// Falls back to local Documents directory if iCloud is not available.
    private func notesDirectory() -> URL {
        if let iCloudURL = iCloudDocumentsURL() {
            return iCloudURL
        }
        // Fallback to local app documents
        let paths = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
        return paths[0]
    }

    /// Sanitize note name for use as a filename.
    private func noteFileName(_ name: String) -> String {
        let unsafe = CharacterSet(charactersIn: "/\\:*?\"<>|")
        let sanitized = name.components(separatedBy: unsafe).joined(separator: "_")
        return sanitized + ".md"
    }

    /// Get the file URL for a note.
    private func noteFileURL(_ name: String) -> URL {
        return notesDirectory().appendingPathComponent(noteFileName(name))
    }

    // MARK: - Plugin Methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        let available = iCloudDocumentsURL() != nil
        call.resolve(["available": available])
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else {
            call.reject("Missing 'name' parameter")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let url = self.noteFileURL(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                call.resolve(["content": NSNull()])
                return
            }
            do {
                let content = try String(contentsOf: url, encoding: .utf8)
                call.resolve(["content": content])
            } catch {
                call.reject("Failed to read note: \(error.localizedDescription)")
            }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let name = call.getString("name"),
              let content = call.getString("content") else {
            call.reject("Missing 'name' or 'content' parameter")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let url = self.noteFileURL(name)
            do {
                // Ensure directory exists
                let dir = url.deletingLastPathComponent()
                if !FileManager.default.fileExists(atPath: dir.path) {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                }
                try content.write(to: url, atomically: true, encoding: .utf8)
                call.resolve()
            } catch {
                call.reject("Failed to write note: \(error.localizedDescription)")
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else {
            call.reject("Missing 'name' parameter")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let url = self.noteFileURL(name)
            if FileManager.default.fileExists(atPath: url.path) {
                do {
                    try FileManager.default.removeItem(at: url)
                } catch {
                    call.reject("Failed to delete note: \(error.localizedDescription)")
                    return
                }
            }
            call.resolve()
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let dir = self.notesDirectory()
            do {
                let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
                let noteNames = files
                    .filter { $0.hasSuffix(".md") }
                    .map { String($0.dropLast(3)) } // Remove .md extension
                call.resolve(["names": noteNames])
            } catch {
                call.resolve(["names": []])
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let dir = self.notesDirectory()
            var count = 0
            do {
                let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
                for file in files where file.hasSuffix(".md") {
                    let url = dir.appendingPathComponent(file)
                    try FileManager.default.removeItem(at: url)
                    count += 1
                }
            } catch {
                // Continue with what we managed to delete
            }
            call.resolve(["count": count])
        }
    }

    /// Opens a document picker pre-navigated to the notes directory,
    /// letting the user browse the folder in Files app.
    @objc func openFilesLocation(_ call: CAPPluginCall) {
        let dirURL = notesDirectory()
        DispatchQueue.main.async {
            guard let rootVC = self.bridge?.viewController else {
                call.reject("No root view controller available")
                return
            }
            let picker: UIDocumentPickerViewController
            if #available(iOS 14.0, *) {
                picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
            } else {
                picker = UIDocumentPickerViewController(documentTypes: ["public.folder"], in: .open)
            }
            picker.directoryURL = dirURL
            picker.modalPresentationStyle = .fullScreen
            rootVC.present(picker, animated: true, completion: nil)
            call.resolve()
        }
    }
}
