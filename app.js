import { MeshDevice } from "https://esm.sh/jsr/@meshtastic/core@2.6.6";
import { TransportWebBluetooth } from "https://esm.sh/jsr/@meshtastic/transport-web-bluetooth@0.1.2";
import { TransportHTTP } from "https://esm.sh/jsr/@meshtastic/transport-http@0.2.1";

function createToDeviceStream() {
  return new TransformStream({
    transform(chunk, controller) {
      const bufLen = chunk.length;
      const header = new Uint8Array([
        0x94,
        0xc3,
        (bufLen >> 8) & 0xff,
        bufLen & 0xff,
      ]);
      controller.enqueue(new Uint8Array([...header, ...chunk]));
    },
  });
}

function createFromDeviceStream() {
  let byteBuffer = new Uint8Array([]);
  const textDecoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      byteBuffer = new Uint8Array([...byteBuffer, ...chunk]);
      let processingExhausted = false;
      while (byteBuffer.length !== 0 && !processingExhausted) {
        const framingIndex = byteBuffer.findIndex((byte) => byte === 0x94);
        const framingByte2 = byteBuffer[framingIndex + 1];
        if (framingByte2 === 0xc3) {
          if (byteBuffer.subarray(0, framingIndex).length) {
            controller.enqueue({
              type: "debug",
              data: textDecoder.decode(byteBuffer.subarray(0, framingIndex)),
            });
            byteBuffer = byteBuffer.subarray(framingIndex);
          }
          const msb = byteBuffer[2];
          const lsb = byteBuffer[3];
          if (
            msb !== undefined &&
            lsb !== undefined &&
            byteBuffer.length >= 4 + (msb << 8) + lsb
          ) {
            const packet = byteBuffer.subarray(4, 4 + (msb << 8) + lsb);
            const malformedDetectorIndex = packet.findIndex((byte) => byte === 0x94);
            if (
              malformedDetectorIndex !== -1 &&
              packet[malformedDetectorIndex + 1] === 0xc3
            ) {
              console.warn(
                `Malformed packet discarded: ${byteBuffer
                  .subarray(0, malformedDetectorIndex - 1)
                  .toString()}`
              );
              byteBuffer = byteBuffer.subarray(malformedDetectorIndex);
            } else {
              byteBuffer = byteBuffer.subarray(3 + (msb << 8) + lsb + 1);
              controller.enqueue({
                type: "packet",
                data: packet,
              });
            }
          } else {
            processingExhausted = true;
          }
        } else {
          processingExhausted = true;
        }
      }
    },
  });
}

class WebSerialTransport {
  constructor(connection) {
    if (!connection.readable || !connection.writable) {
      throw new Error("Serial stream not accessible");
    }
    this.connection = connection;
    this.abortController = new AbortController();

    const toDeviceStream = createToDeviceStream();
    this.pipePromise = toDeviceStream.readable.pipeTo(connection.writable, {
      signal: this.abortController.signal,
    });
    this._toDevice = toDeviceStream.writable;
    this._fromDevice = connection.readable.pipeThrough(createFromDeviceStream());
  }

  static async create(baudRate = 115200) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    return new WebSerialTransport(port);
  }

  get toDevice() {
    return this._toDevice;
  }

  get fromDevice() {
    return this._fromDevice;
  }

  async disconnect() {
    try {
      this.abortController.abort();
      if (this.pipePromise) {
        try {
          await this.pipePromise;
        } catch (error) {
          if (error instanceof Error && error.name !== "AbortError") {
            throw error;
          }
        }
      }
      if (this.connection?.readable) {
        try {
          const reader = this.connection.readable.getReader();
          await reader.cancel();
          reader.releaseLock();
        } catch {
          // Ignore reader cancellation failures.
        }
      }
      if (this.connection?.writable) {
        try {
          const writer = this.connection.writable.getWriter();
          await writer.close();
          writer.releaseLock();
        } catch {
          // Ignore writer close failures.
        }
      }
      try {
        await this.connection.close();
      } catch (error) {
        if (error instanceof Error && error.message?.includes("locked")) {
          return;
        }
        throw error;
      }
    } catch (error) {
      console.warn("Could not cleanly disconnect serial port:", error);
    }
  }
}

const elements = {
  status: document.getElementById("status"),
  connectionType: document.getElementById("connectionType"),
  ipField: document.getElementById("ipField"),
  ipInput: document.getElementById("ipInput"),
  tlsToggle: document.getElementById("tlsToggle"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearBtn: document.getElementById("clearBtn"),
  nodeTableBody: document.getElementById("nodeTableBody"),
  nodeCount: document.getElementById("nodeCount"),
  nodeInfoText: document.getElementById("nodeInfoText"),
  nodeInfoCount: document.getElementById("nodeInfoCount"),
  downloadLinksBtn: document.getElementById("downloadLinksBtn"),
  nodesTab: document.getElementById("nodesTab"),
  linksTab: document.getElementById("linksTab"),
  nodesPanel: document.getElementById("nodesPanel"),
  linksPanel: document.getElementById("linksPanel"),
  log: document.getElementById("log"),
};

const state = {
  device: null,
  transport: null,
  nodes: new Map(),
  connected: false,
};

function log(message) {
  const now = new Date().toLocaleTimeString();
  elements.log.textContent = `[${now}] ${message}\n${elements.log.textContent}`;
}

function setStatus(text, accent = "var(--accent)") {
  elements.status.textContent = text;
  elements.status.style.color = accent;
}

function setControls(connected) {
  elements.connectBtn.disabled = connected;
  elements.disconnectBtn.disabled = !connected;
  elements.refreshBtn.disabled = !connected;
}

function updateIpField() {
  const isHttp = elements.connectionType.value === "http";
  elements.ipField.style.display = isHttp ? "grid" : "none";
}

function parseHttpTarget(input) {
  let host = input.trim();
  let tls = elements.tlsToggle?.checked ?? false;
  if (!host) return null;
  if (host.startsWith("http//")) {
    host = host.replace(/^http\/+/, "");
  }
  if (host.startsWith("http://")) {
    tls = false;
    host = host.replace(/^http:\/\//, "");
  } else if (host.startsWith("https://")) {
    tls = true;
    host = host.replace(/^https:\/\//, "");
  }
  if (host.includes("/")) {
    host = host.split("/")[0];
  }
  return { host, tls };
}

async function testHttpReachable(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatLastHeard(value) {
  if (!value) return "–";
  const ts = value > 1_000_000_000_000 ? value : value * 1000;
  const diff = Date.now() - ts;
  if (Number.isNaN(diff)) return "–";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatPosition(position) {
  if (!position) return "–";
  const { latitudeI, longitudeI, latitude, longitude } = position;
  const lat = latitude ?? (latitudeI ? latitudeI / 1e7 : null);
  const lon = longitude ?? (longitudeI ? longitudeI / 1e7 : null);
  if (lat == null || lon == null) return "–";
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function toByteArray(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map((entry) => Number(entry));
  if (typeof value === "string") {
    const cleaned = value.replace(/[^a-fA-F0-9]/g, "");
    if (cleaned.length % 2 === 0 && cleaned.length) {
      const bytes = [];
      for (let i = 0; i < cleaned.length; i += 2) {
        bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
      }
      return bytes;
    }
    return null;
  }
  return Object.values(value).map((entry) => Number(entry));
}

function encodeVarint(value) {
  let v = Number(value) >>> 0;
  const bytes = [];
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return bytes;
}

function encodeKey(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(bytes) {
  return [...encodeVarint(bytes.length), ...bytes];
}

function encodeString(value) {
  if (!value) return [];
  const bytes = Array.from(new TextEncoder().encode(String(value)));
  return encodeLengthDelimited(bytes);
}

function encodeBytes(value) {
  const bytes = toByteArray(value);
  if (!bytes || !bytes.length) return [];
  return encodeLengthDelimited(bytes);
}

function encodeUserMessage(user, nodeNum) {
  if (!user) return [];
  const chunks = [];

  const id =
    user.id ||
    (Number.isFinite(nodeNum)
      ? `!${(Number(nodeNum) >>> 0).toString(16).padStart(8, "0")}`
      : null);
  if (id) {
    chunks.push(...encodeKey(1, 2), ...encodeString(id));
  }
  if (user.longName) {
    chunks.push(...encodeKey(2, 2), ...encodeString(user.longName));
  }
  if (user.shortName) {
    chunks.push(...encodeKey(3, 2), ...encodeString(user.shortName));
  }
  if (user.macaddr) {
    const bytes = encodeBytes(user.macaddr);
    if (bytes.length) {
      chunks.push(...encodeKey(4, 2), ...bytes);
    }
  }
  if (user.hwModel !== undefined && user.hwModel !== null) {
    chunks.push(...encodeKey(5, 0), ...encodeVarint(user.hwModel));
  }
  if (user.isLicensed !== undefined && user.isLicensed !== null) {
    chunks.push(...encodeKey(6, 0), ...encodeVarint(user.isLicensed ? 1 : 0));
  }
  if (user.role !== undefined && user.role !== null) {
    chunks.push(...encodeKey(7, 0), ...encodeVarint(user.role));
  }
  if (user.publicKey) {
    const bytes = encodeBytes(user.publicKey);
    if (bytes.length) {
      chunks.push(...encodeKey(8, 2), ...bytes);
    }
  }
  if (user.isUnmessagable !== undefined && user.isUnmessagable !== null) {
    chunks.push(...encodeKey(9, 0), ...encodeVarint(user.isUnmessagable ? 1 : 0));
  }

  return chunks;
}

function encodeNodeInfoMessage(node) {
  if (!node) return null;
  const chunks = [];
  if (node.num !== undefined && node.num !== null) {
    chunks.push(...encodeKey(1, 0), ...encodeVarint(node.num));
  }
  const userBytes = encodeUserMessage(node.user ?? {}, node.num);
  if (userBytes.length) {
    chunks.push(...encodeKey(2, 2), ...encodeLengthDelimited(userBytes));
  }
  return chunks.length ? new Uint8Array(chunks) : null;
}

function base64UrlEncode(bytes) {
  if (!bytes || !bytes.length) return null;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildNodeInfoUrl(node) {
  const message = encodeNodeInfoMessage(node);
  if (!message) return null;
  const encoded = base64UrlEncode(message);
  if (!encoded) return null;
  return `https://meshtastic.org/v/#${encoded}`;
}

function normalizeNode(num) {
  if (!state.nodes.has(num)) {
    state.nodes.set(num, { num });
  }
  return state.nodes.get(num);
}

function persistNodeDb() {
  const nodesObj = {};
  for (const [num, node] of state.nodes.entries()) {
    nodesObj[num] = node;
  }
  sessionStorage.setItem(
    "meshtasticNodeDB",
    JSON.stringify({ updatedAt: Date.now(), nodes: nodesObj })
  );
  localStorage.setItem(
    "meshtasticNodeDB",
    JSON.stringify({ updatedAt: Date.now(), nodes: nodesObj })
  );
}

function renderNodes() {
  const nodes = Array.from(state.nodes.values()).sort((a, b) => a.num - b.num);
  elements.nodeCount.textContent = `${nodes.length} node${nodes.length === 1 ? "" : "s"}`;

  if (!nodes.length) {
    elements.nodeTableBody.innerHTML =
      '<tr class="empty"><td colspan="7">Connect to a node to load the NodeDB.</td></tr>';
    elements.nodeInfoText.value = "Nodes with names will appear here.";
    elements.nodeInfoCount.textContent = "0 links";
    elements.downloadLinksBtn.disabled = true;
    return;
  }

  elements.nodeTableBody.innerHTML = nodes
    .map((node) => {
      const user = node.user ?? {};
      const longName = user.longName ?? "–";
      const shortName = user.shortName ?? "–";
      const hw = user.hwModel ?? node.hwModel ?? "–";
      const lastHeard = formatLastHeard(node.lastHeard ?? node.lastHeardMs);
      const position = formatPosition(node.position);
      const nodeInfoUrl = buildNodeInfoUrl(node);

      return `
        <tr>
          <td>${node.num}</td>
          <td>${shortName}</td>
          <td>${longName}</td>
          <td>${hw}</td>
          <td>${lastHeard}</td>
          <td>${position}</td>
          <td>
            <a href="nodeinfo.html?num=${encodeURIComponent(node.num)}">View</a>
            ${
              nodeInfoUrl
                ? ` · <a href="${nodeInfoUrl}" target="_blank" rel="noopener noreferrer">Open</a>`
                : ""
            }
          </td>
        </tr>
      `;
    })
    .join("");

  const namedNodes = nodes.filter((node) => {
    const user = node.user ?? {};
    const longName = (user.longName ?? "").trim();
    const shortName = (user.shortName ?? "").trim();
    return longName || shortName;
  });

  elements.nodeInfoCount.textContent = `${namedNodes.length} link${
    namedNodes.length === 1 ? "" : "s"
  }`;

  const linkLines = namedNodes
    .map((node) => {
      const user = node.user ?? {};
      const longName = (user.longName ?? "").trim();
      const shortName = (user.shortName ?? "").trim();
      const label = [shortName, longName].filter(Boolean).join(" — ");
      const url = buildNodeInfoUrl(node);
      if (!url) return null;
      return `${label} - ${url}`;
    })
    .filter(Boolean)
    .join("\n");

  elements.nodeInfoText.value = linkLines || "Nodes with names will appear here.";
  elements.downloadLinksBtn.disabled = !linkLines;
}

function setActiveTab(active) {
  const isLinks = active === "links";
  elements.nodesTab.classList.toggle("is-active", !isLinks);
  elements.linksTab.classList.toggle("is-active", isLinks);
  elements.nodesTab.setAttribute("aria-selected", String(!isLinks));
  elements.linksTab.setAttribute("aria-selected", String(isLinks));
  elements.nodesPanel.classList.toggle("is-hidden", isLinks);
  elements.linksPanel.classList.toggle("is-hidden", !isLinks);
}

function downloadLinks() {
  const content = elements.nodeInfoText.value.trim();
  if (!content || content === "Nodes with names will appear here.") return;
  const blob = new Blob([`${content}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "nodesnoop-nodeinfo-links.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function attachNodeHandlers(device) {
  device.events.onNodeInfoPacket.subscribe((nodeInfo) => {
    const node = normalizeNode(nodeInfo.num);
    Object.assign(node, nodeInfo);
    persistNodeDb();
    renderNodes();
  });

  device.events.onUserPacket.subscribe((user) => {
    const node = normalizeNode(user.from);
    node.user = user.data;
    persistNodeDb();
    renderNodes();
  });

  device.events.onPositionPacket.subscribe((position) => {
    const node = normalizeNode(position.from);
    node.position = position.data;
    persistNodeDb();
    renderNodes();
  });

  device.events.onTelemetryPacket.subscribe((telemetry) => {
    const node = normalizeNode(telemetry.from);
    node.telemetry = telemetry.data;
    persistNodeDb();
    renderNodes();
  });
}

async function connect() {
  try {
    setStatus("Connecting…");
    const type = elements.connectionType.value;
    let transport;

    if (type === "serial") {
      if (!("serial" in navigator)) {
        throw new Error("Web Serial not supported. Use Chrome/Edge on HTTPS or localhost.");
      }
      if (!window.isSecureContext) {
        throw new Error("Web Serial requires HTTPS or localhost.");
      }
      transport = await WebSerialTransport.create();
      if (!transport) {
        throw new Error("No serial port selected.");
      }
      log("Selected Web Serial transport.");
    } else if (type === "bluetooth") {
      if (!("bluetooth" in navigator)) {
        throw new Error("Web Bluetooth not supported. Use Chrome/Edge on HTTPS or localhost.");
      }
      if (!window.isSecureContext) {
        throw new Error("Web Bluetooth requires HTTPS or localhost.");
      }
      transport = await TransportWebBluetooth.create();
      if (!transport) {
        throw new Error("No Bluetooth device selected.");
      }
      log("Selected Web Bluetooth transport.");
    } else {
      const target = parseHttpTarget(elements.ipInput.value);
      if (!target || !target.host) {
        setStatus("Missing host", "#d14343");
        log("HTTP connection requires a host or IP.");
        return;
      }
      const reportUrl = `${target.tls ? "https" : "http"}://${target.host}/json/report`;
      const reachable = await testHttpReachable(reportUrl);
      if (!reachable) {
        const message = target.tls
          ? `Cannot reach HTTPS endpoint. If using a self-signed certificate, open ${reportUrl} in a new tab, accept the certificate warning, then try connecting again.`
          : "HTTP endpoint not reachable (may be blocked by CORS).";
        throw new Error(message);
      }
      transport = await TransportHTTP.create(target.host, target.tls);
      log(`Selected HTTP transport: ${target.tls ? "https" : "http"}://${target.host}`);
    }

    const device = new MeshDevice(transport);
    attachNodeHandlers(device);

    state.device = device;
    state.transport = transport;
    state.connected = true;
    setStatus("Connected (syncing…)", "#12805c");
    setControls(true);

    try {
      await device.configure();
      setStatus("Connected", "#12805c");
      log("Device configured. NodeDB sync in progress…");
    } catch (configureError) {
      setStatus("Connected (limited)", "#b45309");
      log(`Configure warning: ${configureError?.message ?? configureError}`);
    }
  } catch (error) {
    setStatus("Connection failed", "#d14343");
    log(`Error: ${error?.message ?? error}`);
    console.error(error);
  }
}

async function disconnect() {
  if (!state.device && !state.transport) return;
  setStatus("Disconnecting…", "#b45309");
  setControls(false);
  try {
    if (state.device?.disconnect) {
      await Promise.race([
        state.device.disconnect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Device disconnect timeout")), 4000)
        ),
      ]);
    }
    if (state.transport?.disconnect) {
      await Promise.race([
        state.transport.disconnect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Transport disconnect timeout")), 4000)
        ),
      ]);
    } else if (state.transport?.connection?.close) {
      await state.transport.connection.close();
    } else if (state.transport?.device?.gatt?.connected) {
      state.transport.device.gatt.disconnect();
    }
  } catch (error) {
    log(`Disconnect error: ${error?.message ?? error}`);
  } finally {
    state.device = null;
    state.transport = null;
    state.connected = false;
    setStatus("Disconnected", "var(--accent)");
    setControls(false);
    log("Disconnected.");
  }
}

async function refreshNodeDb() {
  if (!state.device) return;
  state.nodes.clear();
  renderNodes();
  try {
    await state.device.configure();
    log("Requested NodeDB refresh.");
  } catch (error) {
    log(`Refresh error: ${error?.message ?? error}`);
  }
}

function clearNodeDb() {
  state.nodes.clear();
  renderNodes();
  sessionStorage.removeItem("meshtasticNodeDB");
  localStorage.removeItem("meshtasticNodeDB");
  log("Cleared NodeDB list.");
}

updateIpField();
renderNodes();
setControls(false);

const cached = localStorage.getItem("meshtasticNodeDB");
if (cached) {
  try {
    const parsed = JSON.parse(cached);
    if (parsed?.nodes) {
      for (const [num, node] of Object.entries(parsed.nodes)) {
        state.nodes.set(Number(num), node);
      }
      renderNodes();
    }
  } catch {
    // Ignore cache failures.
  }
}

elements.connectionType.addEventListener("change", updateIpField);
elements.connectBtn.addEventListener("click", connect);
elements.disconnectBtn.addEventListener("click", disconnect);
elements.refreshBtn.addEventListener("click", refreshNodeDb);
elements.clearBtn.addEventListener("click", clearNodeDb);
elements.nodesTab?.addEventListener("click", () => setActiveTab("nodes"));
elements.linksTab?.addEventListener("click", () => setActiveTab("links"));
elements.downloadLinksBtn?.addEventListener("click", downloadLinks);
