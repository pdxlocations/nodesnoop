const params = new URLSearchParams(window.location.search);
const num = params.get("num");

const title = document.getElementById("nodeTitle");
const nodeJson = document.getElementById("nodeJson");

function formatMacHex(macaddr) {
  if (!macaddr) return null;
  const bytes = Array.isArray(macaddr)
    ? macaddr
    : Object.values(macaddr).map((value) => Number(value));
  if (!bytes.length) return null;
  return bytes
    .map((value) => Number(value).toString(16).padStart(2, "0"))
    .join(":");
}

function formatBase64(bytesLike) {
  if (!bytesLike) return null;
  const bytes = Array.isArray(bytesLike)
    ? bytesLike
    : Object.values(bytesLike).map((value) => Number(value));
  if (!bytes.length) return null;
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
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

function encodeFixed32(value) {
  const v = Number(value) >>> 0;
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
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

if (!num) {
  title.textContent = "Node not specified";
  nodeJson.textContent = "Add ?num=### to the URL.";
} else {
  const cached = localStorage.getItem("meshtasticNodeDB");
  if (!cached) {
    title.textContent = `Node ${num}`;
    nodeJson.textContent = "NodeDB cache is empty. Connect first.";
  } else {
    const parsed = JSON.parse(cached);
    const node = parsed?.nodes?.[num];
    if (!node) {
      title.textContent = `Node ${num}`;
      nodeJson.textContent = "Node not found in cache.";
    } else {
      const user = node.user ?? {};
      const { $typeName: _userTypeName, ...userSansType } = user;
      const { $typeName: _nodeTypeName, ...nodeSansType } = node;
      title.textContent = `${user.longName ?? "Node"} (${num})`;
      const macHex = formatMacHex(user.macaddr);
      const pubKeyB64 = formatBase64(user.publicKey);
      const nodeInfoUrl = buildNodeInfoUrl(node);
      const displayNode = {
        ...nodeSansType,
        user: {
          ...userSansType,
          macaddr: macHex ?? user.macaddr,
          publicKey: pubKeyB64 ?? user.publicKey,
        },
        nodeInfoUrl: nodeInfoUrl ?? undefined,
      };
      const prettyJson = JSON.stringify(displayNode, null, 2);
      if (nodeInfoUrl) {
        nodeJson.innerHTML = prettyJson.replace(
          /\"nodeInfoUrl\":\\s*\"([^\"]+)\"/,
          `"nodeInfoUrl": "<a href=\\"${nodeInfoUrl}\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">${nodeInfoUrl}</a>"`
        );
      } else {
        nodeJson.textContent = prettyJson;
      }
    }
  }
}
