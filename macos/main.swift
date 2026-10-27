import Cocoa
import WebKit
import AVFoundation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private var status: NSStatusItem!
    private var window: NSWindow!
    private var web: WKWebView!
    private var server: AssetServer!
    private var port: UInt16 = 0
    private var visible = false
    private var generation = 0
    private var diagnosticPath: String?
    private var microphoneTest = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--diagnostics"), args.count > i + 1 { diagnosticPath = args[i + 1] }
        microphoneTest = args.contains("--microphone-test")
        installMenus()
        do {
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else { throw CocoaError(.fileNoSuchFile) }
            server = try AssetServer(root: root)
            try server.start { [weak self] result in
                switch result {
                case .success(let port): self?.port = port; self?.openWindow()
                case .failure: self?.failStartup()
                }
            }
        } catch { failStartup() }
    }

    private func installMenus() {
        let main = NSMenu()
        let app = NSMenuItem()
        let submenu = NSMenu()
        submenu.addItem(withTitle: "Quit Cicada", action: #selector(quit), keyEquivalent: "q")
        app.submenu = submenu
        main.addItem(app)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let items = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            items.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        edit.submenu = items
        main.addItem(edit)
        NSApp.mainMenu = main
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Cicada")
        status.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Cicada", action: #selector(openWindow), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Cicada", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        status.menu = menu
    }

    @objc private func openWindow() {
        visible = true
        if window == nil {
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Cicada"
            window.minSize = NSSize(width: 360, height: 560)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
        }
        if web == nil { createWebView() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func createWebView() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "cicada")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!))
    }

    private func trusted(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == Int(port)
    }

    private func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == Int(port)
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(visible && trusted(action.request.url) ? .allow : .cancel)
    }

    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ view: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard visible, view === web, frame.isMainFrame, trusted(origin), type == .microphone else { decisionHandler(.deny); return }
        let token = generation
        AVCaptureDevice.requestAccess(for: .audio) { [weak self, weak view] allowed in
            DispatchQueue.main.async {
                guard let self else { decisionHandler(.deny); return }
                decisionHandler(allowed && self.visible && self.generation == token && view === self.web ? .grant : .deny)
            }
        }
    }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard visible, frame.isMainFrame, trusted(frame.securityOrigin) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard visible, message.webView === web, message.frameInfo.isMainFrame, trusted(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "Untrusted request"); return }
        switch action {
        case "readClipboard": replyHandler(NSPasteboard.general.string(forType: .string) ?? "", nil)
        case "writeClipboard":
            guard let text = body["text"] as? String, text.utf8.count <= 1_000_000 else { replyHandler(nil, "Text too large"); return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            replyHandler(true, nil)
        case "saveFile":
            guard let encoded = body["base64"] as? String, encoded.utf8.count <= 2_000_000,
                  let bytes = Data(base64Encoded: encoded), let name = body["name"] as? String, name.utf8.count <= 1024 else { replyHandler(nil, "Invalid file"); return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (name as NSString).lastPathComponent
            panel.beginSheetModal(for: window) { [weak self] response in
                guard self?.visible == true, response == .OK, let url = panel.url else { replyHandler(NSNull(), nil); return }
                do { try bytes.write(to: url, options: .atomic); replyHandler(url.lastPathComponent, nil) }
                catch { replyHandler(nil, "Could not save the file"); }
            }
        default: replyHandler(nil, "Unknown action")
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeAudio()
        return true
    }

    private func closeAudio() {
        visible = false
        generation += 1
        guard let old = web else { return }
        old.evaluateJavaScript("window.cicadaShutdown?.()", completionHandler: nil)
        old.setMicrophoneCaptureState(.none, completionHandler: nil)
        old.setAllMediaPlaybackSuspended(true, completionHandler: nil)
        old.configuration.userContentController.removeScriptMessageHandler(forName: "cicada", contentWorld: .page)
        old.stopLoading()
        old.navigationDelegate = nil
        old.uiDelegate = nil
        old.removeFromSuperview()
        web = nil
        window.contentView = nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { closeAudio(); server?.stop() }
    @objc private func quit() { NSApp.terminate(nil) }

    private func failStartup() {
        if diagnosticPath != nil { writeDiagnostics(["error": "Local asset server failed"]); return }
        let alert = NSAlert()
        alert.messageText = "Cicada could not start its local asset server."
        alert.runModal()
        NSApp.terminate(nil)
    }

    // Explicit diagnostics mode exercises the real WebView and capture worklet.
    // It writes counts/levels only, never recorded audio or clipboard contents.
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        guard diagnosticPath != nil else { return }
        let microphone = microphoneTest ? "true" : "false"
        let script = """
        const result = { secureContext: isSecureContext, microphoneAPI: typeof navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode, microphoneTest: \(microphone) };
        let ctx, stream, source, node;
        try {
          ctx = new AudioContext();
          await ctx.resume();
          await ctx.audioWorklet.addModule('capture-worklet.js');
          node = new AudioWorkletNode(ctx, 'capture');
          const gain = ctx.createGain(); gain.gain.value = 0; node.connect(gain).connect(ctx.destination);
          if (\(microphone)) {
            stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
            source = ctx.createMediaStreamSource(stream); result.trackState = stream.getAudioTracks()[0].readyState;
            result.echoCancellation = stream.getAudioTracks()[0].getSettings().echoCancellation;
          } else { source = ctx.createConstantSource(); source.offset.value = 0.2; source.start(); }
          result.samples = 0; result.peak = 0; result.sampleRate = ctx.sampleRate;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No worklet samples')), 5000);
            node.port.onmessage = ({data}) => { result.samples += data.length; for(const x of data) result.peak = Math.max(result.peak,Math.abs(x)); if(result.samples >= ctx.sampleRate) { clearTimeout(timer); resolve(); } };
            source.connect(node);
          });
          result.contextState = ctx.state;
        } catch (error) { result.error = error.name + ': ' + error.message; }
        finally { stream?.getTracks().forEach(t=>t.stop()); source?.disconnect(); node?.disconnect(); await ctx?.close(); }
        return result;
        """
        view.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            switch result {
            case .success(let value): self?.writeDiagnostics(value as? [String: Any] ?? ["error": "Invalid diagnostics response"])
            case .failure: self?.writeDiagnostics(["error": "WebView diagnostics failed"])
            }
        }
    }

    private func writeDiagnostics(_ result: [String: Any]) {
        if let path = diagnosticPath, let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        NSApp.terminate(nil)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
