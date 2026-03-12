import Foundation
import EventKit
import Capacitor

/// Native Capacitor plugin providing bidirectional iOS Calendar (EventKit) access.
///
/// Methods:
///   - requestAccess()        → { granted: Bool }
///   - listCalendars()        → { calendars: [{ id, title, color, source }] }
///   - fetchEvents(startDate, endDate, calendarIds?) → { events: [...] }
///   - createEvent(title, startDate, endDate, allDay, calendarId?, notes?)
///   - updateEvent(eventId, title?, startDate?, endDate?, allDay?, notes?)
///   - deleteEvent(eventId)
///   - getFirstSyncDate()     → { date: String? }
///   - setFirstSyncDate(date)
///
/// Xcode requirements:
///   - Add NSCalendarsUsageDescription to Info.plist
///   - Add NSCalendarsFullAccessUsageDescription to Info.plist (iOS 17+)
@objc(CalendarPlugin)
public class CalendarPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "CalendarPlugin"
    public let jsName = "CalendarPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAccess",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listCalendars",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchEvents",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createEvent",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateEvent",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteEvent",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFirstSyncDate",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFirstSyncDate",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startWatching",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWatching",         returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getOrCreateCalendar",  returnType: CAPPluginReturnPromise),
    ]

    private let store = EKEventStore()
    private let dateFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let syncDateKey = "com.notesapp.calendar.firstSyncDate"
    private var changeObserver: NSObjectProtocol?

    // MARK: - Helpers

    private func resolve(_ call: CAPPluginCall, block: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async(execute: block)
    }

    private func dateFromISO(_ string: String?) -> Date? {
        guard let s = string else { return nil }
        return dateFormatter.date(from: s)
    }

    private func isoFromDate(_ date: Date) -> String {
        return dateFormatter.string(from: date)
    }

    private func eventToDict(_ event: EKEvent) -> [String: Any] {
        var dict: [String: Any] = [
            "eventId": event.eventIdentifier ?? "",
            "title": event.title ?? "",
            "startDate": isoFromDate(event.startDate),
            "endDate": isoFromDate(event.endDate),
            "allDay": event.isAllDay,
            "calendarId": event.calendar?.calendarIdentifier ?? "",
            "calendarTitle": event.calendar?.title ?? ""
        ]
        if let notes = event.notes {
            dict["notes"] = notes
        }
        return dict
    }

    // MARK: - Plugin methods

    /// Request full calendar access (iOS 17+ uses requestFullAccessToEvents).
    @objc func requestAccess(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) {
            store.requestFullAccessToEvents { granted, error in
                call.resolve(["granted": granted])
            }
        } else {
            store.requestAccess(to: .event) { granted, error in
                call.resolve(["granted": granted])
            }
        }
    }

    /// List all calendars available on the device.
    @objc func listCalendars(_ call: CAPPluginCall) {
        resolve(call) {
            let calendars = self.store.calendars(for: .event)
            let list = calendars.map { cal -> [String: Any] in
                var color = "#888888"
                if let cgColor = cal.cgColor {
                    let c = CIColor(cgColor: cgColor)
                    color = String(format: "#%02X%02X%02X",
                                   Int(c.red * 255), Int(c.green * 255), Int(c.blue * 255))
                }
                return [
                    "id": cal.calendarIdentifier,
                    "title": cal.title,
                    "color": color,
                    "source": cal.source?.title ?? ""
                ]
            }
            call.resolve(["calendars": list])
        }
    }

    /// Fetch events between two dates, optionally filtered to specific calendars.
    /// Parameters:
    ///   - startDate (String, ISO8601)
    ///   - endDate (String, ISO8601)
    ///   - calendarIds ([String], optional)
    @objc func fetchEvents(_ call: CAPPluginCall) {
        guard let startStr = call.getString("startDate"),
              let endStr = call.getString("endDate"),
              let start = dateFromISO(startStr),
              let end = dateFromISO(endStr) else {
            call.reject("startDate and endDate are required (ISO8601)")
            return
        }

        resolve(call) {
            var calendars: [EKCalendar]? = nil
            if let ids = call.getArray("calendarIds") as? [String], !ids.isEmpty {
                calendars = ids.compactMap { self.store.calendar(withIdentifier: $0) }
            }
            let predicate = self.store.predicateForEvents(withStart: start, end: end, calendars: calendars)
            let events = self.store.events(matching: predicate)
            let list = events.map { self.eventToDict($0) }
            call.resolve(["events": list])
        }
    }

    /// Create a new calendar event.
    /// Parameters:
    ///   - title (String)
    ///   - startDate (String, ISO8601)
    ///   - endDate (String, ISO8601)
    ///   - allDay (Bool, optional, default false)
    ///   - calendarId (String, optional — defaults to default calendar)
    ///   - notes (String, optional)
    @objc func createEvent(_ call: CAPPluginCall) {
        guard let title = call.getString("title"),
              let startStr = call.getString("startDate"),
              let endStr = call.getString("endDate"),
              let start = dateFromISO(startStr),
              let end = dateFromISO(endStr) else {
            call.reject("title, startDate, and endDate are required")
            return
        }

        resolve(call) {
            let event = EKEvent(eventStore: self.store)
            event.title = title
            event.startDate = start
            event.endDate = end
            event.isAllDay = call.getBool("allDay") ?? false
            if let notes = call.getString("notes") {
                event.notes = notes
            }

            if let calId = call.getString("calendarId"),
               let cal = self.store.calendar(withIdentifier: calId) {
                event.calendar = cal
            } else {
                event.calendar = self.store.defaultCalendarForNewEvents
            }

            do {
                try self.store.save(event, span: .thisEvent)
                call.resolve(["eventId": event.eventIdentifier ?? ""])
            } catch {
                call.reject("Failed to create event", nil, error)
            }
        }
    }

    /// Update an existing calendar event.
    @objc func updateEvent(_ call: CAPPluginCall) {
        guard let eventId = call.getString("eventId") else {
            call.reject("eventId is required")
            return
        }

        resolve(call) {
            guard let event = self.store.event(withIdentifier: eventId) else {
                call.reject("Event not found")
                return
            }

            if let title = call.getString("title") { event.title = title }
            if let startStr = call.getString("startDate"),
               let start = self.dateFromISO(startStr) { event.startDate = start }
            if let endStr = call.getString("endDate"),
               let end = self.dateFromISO(endStr) { event.endDate = end }
            if let allDay = call.getBool("allDay") { event.isAllDay = allDay }
            if let notes = call.getString("notes") { event.notes = notes }

            do {
                try self.store.save(event, span: .thisEvent)
                call.resolve()
            } catch {
                call.reject("Failed to update event", nil, error)
            }
        }
    }

    /// Delete a calendar event.
    @objc func deleteEvent(_ call: CAPPluginCall) {
        guard let eventId = call.getString("eventId") else {
            call.reject("eventId is required")
            return
        }

        resolve(call) {
            guard let event = self.store.event(withIdentifier: eventId) else {
                call.resolve()
                return
            }
            do {
                try self.store.remove(event, span: .thisEvent)
                call.resolve()
            } catch {
                call.reject("Failed to delete event", nil, error)
            }
        }
    }

    /// Get the date of the first calendar sync (stored in UserDefaults).
    @objc func getFirstSyncDate(_ call: CAPPluginCall) {
        let date = UserDefaults.standard.string(forKey: syncDateKey)
        call.resolve(["date": date ?? ""])
    }

    /// Set the date of the first calendar sync.
    @objc func setFirstSyncDate(_ call: CAPPluginCall) {
        guard let date = call.getString("date") else {
            call.reject("date is required")
            return
        }
        UserDefaults.standard.set(date, forKey: syncDateKey)
        call.resolve()
    }

    /// Start watching for EKEventStore changes.
    @objc func startWatching(_ call: CAPPluginCall) {
        if changeObserver == nil {
            changeObserver = NotificationCenter.default.addObserver(
                forName: .EKEventStoreChanged,
                object: store,
                queue: .main
            ) { [weak self] _ in
                self?.notifyListeners("calendarChanged", data: [:])
            }
        }
        call.resolve()
    }

    /// Find an existing calendar by title on the iCloud source, or create it if absent.
    /// Parameters:
    ///   - title (String) — calendar display name
    /// Returns: { calendarId: String }
    @objc func getOrCreateCalendar(_ call: CAPPluginCall) {
        guard let title = call.getString("title") else {
            call.reject("title is required")
            return
        }

        resolve(call) {
            // Prefer iCloud CalDAV source so the calendar syncs via iCloud.
            let iCloudSource = self.store.sources.first {
                $0.sourceType == .calDAV && $0.title.lowercased() == "icloud"
            } ?? self.store.sources.first {
                $0.sourceType == .calDAV
            } ?? self.store.sources.first {
                $0.sourceType == .local
            }

            // Look for an existing calendar with this title on the chosen source.
            if let existing = self.store.calendars(for: .event).first(where: {
                $0.title == title && ($0.source?.sourceIdentifier == iCloudSource?.sourceIdentifier)
            }) {
                call.resolve(["calendarId": existing.calendarIdentifier])
                return
            }

            // Create a new calendar.
            guard let source = iCloudSource else {
                call.reject("No suitable calendar source found")
                return
            }

            let calendar = EKCalendar(for: .event, eventStore: self.store)
            calendar.title = title
            calendar.source = source

            do {
                try self.store.saveCalendar(calendar, commit: true)
                call.resolve(["calendarId": calendar.calendarIdentifier])
            } catch {
                call.reject("Failed to create calendar", nil, error)
            }
        }
    }

    /// Stop watching for EKEventStore changes.
    @objc func stopWatching(_ call: CAPPluginCall) {
        if let observer = changeObserver {
            NotificationCenter.default.removeObserver(observer)
            changeObserver = nil
        }
        call.resolve()
    }
}
