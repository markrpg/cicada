import Foundation
import Network

// Only explicitly bundled assets are addressable. No user files or received data
// pass through this listener, and it never binds to a LAN interface.
final class AssetServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.cicada.assets")
    private var listener: NWListener?
    private var clients: [UUID: NWConnection] = [:]
    private let assets: [String: Data]
    private(set) var port: UInt16 = 0

    init(root: URL) throws {
        var files: [String: Data] = [:]
        for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) {
            let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard info.isRegularFile == true, info.isSymbolicLink != true,
                  ["html", "js", "css", "svg", "png"].contains(url.pathExtension) else { continue }
            files["/" + url.lastPathComponent] = try Data(contentsOf: url)
        }
        assets = files
    }

    func start(ready: @escaping (Result<UInt16, Error>) -> Void) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let server = try NWListener(using: params)
        listener = server
        var reported = false
        server.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !reported, let port = server.port?.rawValue else { return }
                reported = true
                self.port = port
                DispatchQueue.main.async { ready(.success(port)) }
            case .failed(let error):
                guard !reported else { return }
                reported = true
                DispatchQueue.main.async { ready(.failure(error)) }
            default: break
            }
        }
        server.newConnectionHandler = { [weak self] connection in
            guard let self, self.clients.count < 32 else { connection.cancel(); return }
            let id = UUID()
            self.clients[id] = connection
            connection.start(queue: self.queue)
            self.read(connection, id: id, head: Data())
            self.queue.asyncAfter(deadline: .now() + 5) { self.finish(id) }
        }
        server.start(queue: queue)
    }

    private func read(_ connection: NWConnection, id: UUID, head: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, error in
            guard let self, self.clients[id] != nil else { return }
            var bytes = head
            if let data { bytes.append(data) }
            guard bytes.count <= 16384 else { self.respond(connection, id: id, status: 413); return }
            if let end = bytes.range(of: Data("\r\n\r\n".utf8)) {
                self.handle(connection, id: id, head: bytes.subdata(in: 0..<end.lowerBound))
            } else if done || error != nil { self.finish(id) }
            else { self.read(connection, id: id, head: bytes) }
        }
    }

    private func handle(_ connection: NWConnection, id: UUID, head: Data) {
        guard let text = String(data: head, encoding: .utf8) else { respond(connection, id: id, status: 400); return }
        let lines = text.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ")
        guard request.count == 3, request[2] == "HTTP/1.1" else { respond(connection, id: id, status: 400); return }
        guard request[0] == "GET" || request[0] == "HEAD" else { respond(connection, id: id, status: 405); return }
        let hosts = lines.dropFirst().filter { $0.lowercased().hasPrefix("host:") }
        guard hosts.count == 1, hosts[0].dropFirst(5).trimmingCharacters(in: .whitespaces) == "127.0.0.1:\(port)" else {
            respond(connection, id: id, status: 421); return
        }
        let raw = String(request[1]).components(separatedBy: "?")[0]
        guard var path = raw.removingPercentEncoding, path.hasPrefix("/"), !path.contains(".."), !path.contains("\\") else {
            respond(connection, id: id, status: 404); return
        }
        if path == "/" { path = "/index.html" }
        guard let body = assets[path] else { respond(connection, id: id, status: 404); return }
        let ext = (path as NSString).pathExtension
        let mime = ["js": "text/javascript", "html": "text/html", "css": "text/css", "svg": "image/svg+xml", "png": "image/png"][ext] ?? "application/octet-stream"
        respond(connection, id: id, status: 200, body: body, mime: mime, headOnly: request[0] == "HEAD")
    }

    private func respond(_ connection: NWConnection, id: UUID, status: Int, body: Data = Data(), mime: String = "text/plain", headOnly: Bool = false) {
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 413: "Content Too Large", 421: "Misdirected Request"][status] ?? "Error"
        let csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        let header = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(body.count)\r\nContent-Type: \(mime); charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: \(csp)\r\nConnection: close\r\n\r\n"
        var response = Data(header.utf8)
        if !headOnly { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.finish(id) })
    }

    private func finish(_ id: UUID) { clients.removeValue(forKey: id)?.cancel() }

    func stop() {
        queue.async {
            self.listener?.cancel()
            for client in self.clients.values { client.cancel() }
            self.clients.removeAll()
        }
    }
}
