// HarnessNotify - shows the harness's notifications natively, with buttons (owner, 2026-10-21).
// It watches ~/.harness/notify/queue/*.json (written by scripts/notify.mjs), posts each one with
// its own buttons, and on a click runs the record's handler:
//   <node> <repo>/scripts/notify.mjs respond <id> <action> [typed text]
// It runs nothing else. Build and install: tools/harness-notify/build.sh
import AppKit
import Foundation
import UserNotifications

struct Act: Decodable { let id: String; let label: String; let text: Bool?; let placeholder: String?; let destructive: Bool? }
struct Item: Decodable { let id: String; let title: String; let subtitle: String?; let body: String; let actions: [Act]; let handler: [String]; let sound: Bool? }

let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".harness/notify")
let queue = base.appendingPathComponent("queue")
let posted = base.appendingPathComponent("posted")

final class App: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    var categories: [String: UNNotificationCategory] = [:]
    var order: [String] = []
    var handlers: [String: [String]] = [:]

    func applicationDidFinishLaunching(_ n: Notification) {
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in
            if !granted { NSLog("HarnessNotify: notifications not allowed (%@) - System Settings > Notifications > HarnessNotify", String(describing: err)) }
        }
        try? FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: posted, withIntermediateDirectories: true)
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in self.poll() }
    }

    func poll() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: queue, includingPropertiesForKeys: nil) else { return }
        for f in files.filter({ $0.pathExtension == "json" && !$0.lastPathComponent.hasPrefix(".") }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            defer { try? FileManager.default.moveItem(at: f, to: posted.appendingPathComponent(f.lastPathComponent)) }
            guard let data = try? Data(contentsOf: f), let item = try? JSONDecoder().decode(Item.self, from: data) else { continue }
            show(item)
        }
    }

    func show(_ item: Item) {
        let catId = "hn.\(item.id)"
        let acts: [UNNotificationAction] = item.actions.map { a in
            let opts: UNNotificationActionOptions = (a.destructive ?? false) ? [.destructive] : []
            if a.text ?? false {
                return UNTextInputNotificationAction(identifier: a.id, title: a.label, options: opts, textInputButtonTitle: "Send", textInputPlaceholder: a.placeholder ?? "")
            }
            return UNNotificationAction(identifier: a.id, title: a.label, options: opts)
        }
        categories[catId] = UNNotificationCategory(identifier: catId, actions: acts, intentIdentifiers: [], options: [.customDismissAction])
        order.append(catId)
        if order.count > 60 { categories.removeValue(forKey: order.removeFirst()) }
        handlers[item.id] = item.handler
        center.setNotificationCategories(Set(categories.values))
        let c = UNMutableNotificationContent()
        c.title = item.title
        if let s = item.subtitle, !s.isEmpty { c.subtitle = s }
        c.body = item.body
        c.categoryIdentifier = catId
        c.userInfo = ["id": item.id, "handler": item.handler]
        if item.sound ?? false { c.sound = .default }
        // categories register asynchronously; a short delay keeps the buttons on the first notification
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            self.center.add(UNNotificationRequest(identifier: item.id, content: c, trigger: nil)) { err in
                if let err = err { NSLog("HarnessNotify: %@", err.localizedDescription) }
            }
        }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let info = r.notification.request.content.userInfo
        let id = info["id"] as? String ?? r.notification.request.identifier
        let handler = (info["handler"] as? [String]) ?? handlers[id] ?? []
        var action = r.actionIdentifier
        if action == UNNotificationDefaultActionIdentifier { action = "default" }
        if action == UNNotificationDismissActionIdentifier { action = "dismiss" }
        var args = Array(handler.dropFirst()) + [action]
        if let t = r as? UNTextInputNotificationResponse { args.append(t.userText) }
        if let exe = handler.first {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = args
            do { try p.run() } catch { NSLog("HarnessNotify: handler failed: %@", error.localizedDescription) }
        }
        done()
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
