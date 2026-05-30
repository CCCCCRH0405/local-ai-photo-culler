// PhotoKit helper for Local AI Photo Culler
//
// A tiny command-line bridge to the macOS Photos library. Electron can't touch
// PhotoKit, and Photos has no AppleScript `delete` verb, so deletions that need
// to land in Photos' "Recently Deleted" (30-day recoverable) album must go
// through PHAssetChangeRequest.deleteAssets here.
//
// Commands (all emit JSON on stdout):
//   auth-status                         report current Photos authorization (no prompt)
//   request-auth                        request read/write access (shows the system prompt)
//   list   --limit N                    most-recent-first image assets
//   export --id ID --out PATH --max N   write a JPEG (long edge <= N) for one asset
//   delete --ids ID1,ID2,...            move assets to Recently Deleted (system confirms)
//
// We set up an NSApplication accessory so the system's delete-confirmation
// dialog has a run loop to present on. All PhotoKit work runs on a background
// queue and calls exit() when finished.

import Foundation
import Photos
import AppKit

// MARK: - IO helpers

func emit(_ obj: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  emit(["error": message])
  exit(code)
}

let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()

func iso(_ date: Date?) -> String {
  guard let date = date else { return "" }
  return isoFormatter.string(from: date)
}

private let isoFractional: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

private let dateOnly: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd"
  f.timeZone = TimeZone.current
  return f
}()

/// Parses dates coming from JS: ISO with/without fractional seconds, or yyyy-MM-dd.
func parseDate(_ value: String?) -> Date? {
  guard let value = value, !value.isEmpty else { return nil }
  return isoFractional.date(from: value)
    ?? isoFormatter.date(from: value)
    ?? dateOnly.date(from: value)
}

func authName(_ status: PHAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .authorized: return "authorized"
  case .limited: return "limited"
  @unknown default: return "unknown"
  }
}

// MARK: - Arg parsing

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  fail("usage: photokit-helper <auth-status|request-auth|list|export|delete> [options]")
}

func option(_ name: String) -> String? {
  guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
  return args[idx + 1]
}

// MARK: - Authorization gate

/// Calls `work` with a usable status. Only `request-auth` is allowed to trigger
/// the system prompt; every other command reports `not_authorized` and exits so
/// it can never hang waiting on a dialog.
@Sendable func ensureAuthorized(allowPrompt: Bool, _ work: @escaping @Sendable (PHAuthorizationStatus) -> Void) {
  let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
  if status == .authorized || status == .limited {
    work(status)
    return
  }
  if status == .notDetermined && allowPrompt {
    PHPhotoLibrary.requestAuthorization(for: .readWrite) { newStatus in
      if newStatus == .authorized || newStatus == .limited {
        work(newStatus)
      } else {
        emit(["error": "not_authorized", "status": authName(newStatus)])
        exit(2)
      }
    }
    return
  }
  emit(["error": "not_authorized", "status": authName(status)])
  exit(2)
}

// MARK: - Commands

func runAuthStatus(prompt: Bool) {
  if prompt {
    let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    if current == .notDetermined {
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
        emit(["status": authName(s)])
        exit(0)
      }
      return
    }
    emit(["status": authName(current)])
    exit(0)
  } else {
    emit(["status": authName(PHPhotoLibrary.authorizationStatus(for: .readWrite))])
    exit(0)
  }
}

@Sendable func fetchPredicate(after: Date?, before: Date?, screenshotsOnly: Bool) -> NSPredicate? {
  var parts: [NSPredicate] = []
  if let after = after { parts.append(NSPredicate(format: "creationDate > %@", after as NSDate)) }
  if let before = before { parts.append(NSPredicate(format: "creationDate <= %@", before as NSDate)) }
  if screenshotsOnly {
    parts.append(
      NSPredicate(format: "(mediaSubtypes & %ld) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue)
    )
  }
  if parts.isEmpty { return nil }
  return NSCompoundPredicate(andPredicateWithSubpredicates: parts)
}

func runCount(after: Date?, before: Date?, screenshotsOnly: Bool) {
  ensureAuthorized(allowPrompt: false) { _ in
    let options = PHFetchOptions()
    options.predicate = fetchPredicate(after: after, before: before, screenshotsOnly: screenshotsOnly)
    let fetch = PHAsset.fetchAssets(with: .image, options: options)
    emit(["count": fetch.count])
    exit(0)
  }
}

func runList(limit: Int, order: String, after: Date?, before: Date?, screenshotsOnly: Bool) {
  ensureAuthorized(allowPrompt: false) { _ in
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: order == "asc")]
    options.predicate = fetchPredicate(after: after, before: before, screenshotsOnly: screenshotsOnly)
    if limit > 0 { options.fetchLimit = limit }
    let fetch = PHAsset.fetchAssets(with: .image, options: options)

    var rows: [[String: Any]] = []
    fetch.enumerateObjects { asset, _, _ in
      let resources = PHAssetResource.assetResources(for: asset)
      let primary = resources.first { $0.type == .photo } ?? resources.first
      var sizeBytes: Int64 = 0
      if let r = primary, let s = r.value(forKey: "fileSize") as? Int64 {
        sizeBytes = s
      }
      rows.append([
        "localIdentifier": asset.localIdentifier,
        "fileName": primary?.originalFilename ?? "",
        "creationDate": iso(asset.creationDate),
        "modificationDate": iso(asset.modificationDate),
        "pixelWidth": asset.pixelWidth,
        "pixelHeight": asset.pixelHeight,
        "isFavorite": asset.isFavorite,
        "isScreenshot": asset.mediaSubtypes.contains(.photoScreenshot),
        "sizeBytes": sizeBytes
      ])
    }
    emit(rows)
    exit(0)
  }
}

func runExport(id: String, outPath: String, maxDim: Int) {
  ensureAuthorized(allowPrompt: false) { _ in
    let fetch = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
    guard let asset = fetch.firstObject else {
      fail("not_found", code: 3)
    }
    let opts = PHImageRequestOptions()
    opts.isSynchronous = true
    opts.deliveryMode = .highQualityFormat
    opts.isNetworkAccessAllowed = true
    opts.resizeMode = .exact
    let target = CGSize(width: maxDim, height: maxDim)
    PHImageManager.default().requestImage(
      for: asset,
      targetSize: target,
      contentMode: .aspectFit,
      options: opts
    ) { image, _ in
      guard let image = image,
            let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
        fail("export_failed", code: 4)
      }
      do {
        try jpeg.write(to: URL(fileURLWithPath: outPath))
      } catch {
        fail("write_failed: \(error.localizedDescription)", code: 5)
      }
      emit(["ok": true, "out": outPath])
      exit(0)
    }
  }
}

func runDelete(ids: [String]) {
  ensureAuthorized(allowPrompt: false) { _ in
    let fetch = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
    var found: [PHAsset] = []
    fetch.enumerateObjects { asset, _, _ in found.append(asset) }
    if found.isEmpty {
      emit(["ok": false, "deleted": 0, "error": "none_found"])
      exit(3)
    }
    PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest.deleteAssets(found as NSArray)
    } completionHandler: { success, error in
      if success {
        emit(["ok": true, "deleted": found.count])
        exit(0)
      } else {
        // success=false also covers the user cancelling the confirm dialog.
        emit(["ok": false, "deleted": 0, "error": error?.localizedDescription ?? "user_cancelled_or_failed"])
        exit(6)
      }
    }
  }
}

// MARK: - Run

// Accessory app so the system delete-confirmation dialog has somewhere to show.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

DispatchQueue.global().async {
  switch command {
  case "auth-status":
    runAuthStatus(prompt: false)
  case "request-auth":
    runAuthStatus(prompt: true)
  case "list":
    runList(
      limit: Int(option("--limit") ?? "200") ?? 200,
      order: option("--order") ?? "desc",
      after: parseDate(option("--after")),
      before: parseDate(option("--before")),
      screenshotsOnly: args.contains("--screenshots-only")
    )
  case "count":
    runCount(
      after: parseDate(option("--after")),
      before: parseDate(option("--before")),
      screenshotsOnly: args.contains("--screenshots-only")
    )
  case "export":
    guard let id = option("--id"), let out = option("--out") else {
      fail("export requires --id and --out")
    }
    runExport(id: id, outPath: out, maxDim: Int(option("--max") ?? "1280") ?? 1280)
  case "delete":
    let ids = (option("--ids") ?? "")
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if ids.isEmpty { fail("delete requires --ids id1,id2,...") }
    runDelete(ids: ids)
  default:
    fail("unknown command: \(command)")
  }
}

app.run()
