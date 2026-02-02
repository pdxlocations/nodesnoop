# NodeSnoop

Quick-start instructions for running the Meshtastic NodeDB Viewer locally.

## Requirements
- A Chromium-based browser (Chrome, Edge, Brave) for Web Serial and Web Bluetooth.
- A Meshtastic node reachable over USB (serial), Web Bluetooth, or HTTP(S).

## Run locally
1. Start a simple static web server from this repo:
   ```sh
   python3 -m http.server 8000
   ```
2. Open the app in your browser:
   - http://localhost:8000/index.html
3. Choose a connection method and click **Connect**.

## Connection notes
- **Serial (USB):** Use a Chromium-based browser and grant the serial port permission when prompted.
- **Bluetooth (Web BLE):** Use a Chromium-based browser and select your device when prompted.
- **HTTP(S):** Enter `host`, `host:port`, or a full URL (e.g. `http://10.10.0.57:8080`). The app normalizes it.

## Optional
- Open `nodeinfo.html` by clicking **View** in the node list to see JSON details for a node.

## Run as a systemd service (Linux)
This app is a static site. You can serve it with `python3 -m http.server` under systemd.

### System service (recommended for all users on the machine)
1. Create a service file at `/etc/systemd/system/nodesnoop.service`:
   ```ini
   [Unit]
   Description=NodeSnoop static web server
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/path/to/nodesnoop
   ExecStart=/usr/bin/python3 -m http.server 8000 --directory /path/to/nodesnoop
   Restart=on-failure
   User=www-data
   Group=www-data

   [Install]
   WantedBy=multi-user.target
   ```
2. Reload systemd and enable the service:
   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now nodesnoop
   ```
3. Open the app:
   - http://localhost:8000/index.html


### Notes for systemd
- Replace `/path/to/nodesnoop` with the actual repo path.
- If you want to bind to port 80, change `8000` to `80` and ensure the service user has permission.
- Web Serial and Web Bluetooth require a secure context (HTTPS or localhost). If you serve this over the network, consider placing it behind HTTPS (e.g., nginx or Caddy) so those features work in browsers.
