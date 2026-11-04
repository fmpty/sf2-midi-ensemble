import Foundation
import AVFoundation
import Capacitor
import CoreMIDI
import UIKit

/**
 * 原生 MIDI 桥（iOS / iPadOS）。
 *
 * iOS 系统会自动接管 BLE-MIDI（蓝牙）与 USB-MIDI 设备，
 * 这里通过 CoreMIDI 枚举所有 MIDI 源并把原始字节流通过 Capacitor 事件送入 WKWebView。
 */
@objc(MidiBridgePlugin)
public class MidiBridgePlugin: CAPPlugin {

    private var client = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var connected: Set<Int32> = []
    private var refToId: [Int: Int32] = [:]
    private var devices: [[String: Any]] = []

    public override func load() {
        super.load()
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = true
        }
        configureAudioSession()
        setupCoreMidi()
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .defaultToSpeaker])
            try session.setActive(true)
        } catch {
            NSLog("MidiBridge: AVAudioSession 设置失败 \(error)")
        }
    }

    private func setupCoreMidi() {
        var status = MIDIClientCreateWithBlock("SF2MIDIEnsemble" as CFString, &client) { [weak self] notification in
            let messageID = notification.pointee.messageID
            if messageID == .setupChanged || messageID == .addRemoveDevice
                || messageID == .objectAdded || messageID == .objectRemoved {
                DispatchQueue.main.async { self?.connectAllSources() }
            }
        }
        guard status == noErr else {
            NSLog("MidiBridge: MIDIClientCreateWithBlock 失败 \(status)")
            return
        }
        status = MIDIInputPortCreateWithBlock(client, "SF2 MIDI Ensemble Input" as CFString, &inputPort) { [weak self] packetList, srcConnRefCon in
            guard let refCon = srcConnRefCon else { return }
            let key = Int(bitPattern: refCon)
            let uid = self?.refToId[key] ?? 0
            self?.handlePackets(packetList, source: uid)
        }
        guard status == noErr else {
            NSLog("MidiBridge: MIDIInputPortCreateWithBlock 失败 \(status)")
            return
        }
        connectAllSources()
    }

    private func connectAllSources() {
        let count = MIDIGetNumberOfSources()
        var list: [[String: Any]] = []
        for i in 0..<count {
            let src = MIDIGetSource(i)
            var uid: Int32 = 0
            MIDIObjectGetIntegerProperty(src, kMIDIPropertyUniqueID, &uid)
            var nameRef: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(src, kMIDIPropertyDisplayName, &nameRef)
            var manufacturerRef: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(src, kMIDIPropertyManufacturer, &manufacturerRef)
            let name = nameRef.map { $0.takeRetainedValue() as String } ?? "MIDI 设备 \(i)"
            let manufacturer = manufacturerRef.map { $0.takeRetainedValue() as String } ?? ""

            if !connected.contains(uid) {
                connected.insert(uid)
                let ptr = UnsafeMutableRawPointer.allocate(byteCount: 4, alignment: 4)
                ptr.storeBytes(of: uid, as: Int32.self)
                refToId[Int(bitPattern: ptr)] = uid
                MIDIPortConnectSource(inputPort, src, ptr)
            }
            list.append([
                "id": String(uid),
                "name": name,
                "manufacturer": manufacturer,
                "type": "system",
                "connected": true
            ])
        }
        devices = list
        notifyDevices()
    }

    private func handlePackets(_ listRef: UnsafePointer<MIDIPacketList>, source: Int32) {
        var packet = listRef.pointee.packet
        let total = listRef.pointee.numPackets
        var index: UInt32 = 0
        var messages: [[String: Any]] = []
        while index < total {
            var bytes: [Int] = []
            let length = Int(packet.length)
            withUnsafeBytes(of: &packet.data) { raw in
                let n = min(length, raw.count)
                for i in 0..<n {
                    bytes.append(Int(raw[i]))
                }
            }
            messages.append(["id": String(source), "data": bytes])
            index += 1
            if index < total {
                packet = MIDIPacketNext(&packet).pointee
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            for msg in messages {
                self.notifyListeners("midiMessage", data: msg as [String: Any])
            }
        }
    }

    private func notifyDevices() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.notifyListeners("devicesChanged", data: ["devices": self.devices])
        }
    }

    @objc func getBluetoothPermissionState(_ call: CAPPluginCall) {
        call.resolve(["granted": true])
    }

    @objc func requestBluetoothPermissions(_ call: CAPPluginCall) {
        call.resolve(["granted": true, "alreadyHad": true])
    }

    @objc func getDevices(_ call: CAPPluginCall) {
        connectAllSources()
        call.resolve(["devices": devices])
    }

    /** iOS 由系统接入设备，这里等价于重新枚举 */
    @objc func openAll(_ call: CAPPluginCall) {
        connectAllSources()
        call.resolve(["devices": devices])
    }

    @objc func scanBle(_ call: CAPPluginCall) {
        connectAllSources()
        call.resolve(["devices": devices])
    }

    @objc func closeAll(_ call: CAPPluginCall) {
        call.resolve()
    }
}
