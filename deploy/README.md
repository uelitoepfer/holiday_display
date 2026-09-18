# Deploying to the server (ueli@terminus)

## First-time setup

```bash
cd ~/holiday_display
git pull
npm install

which node   # confirm the path, then fix ExecStart below if it isn't /usr/bin/node

sudo cp deploy/holiday-display.service /etc/systemd/system/holiday-display.service
sudo systemctl daemon-reload
sudo systemctl enable --now holiday-display
```

## After pulling code changes

```bash
cd ~/holiday_display
git pull
npm install   # only needed if package.json changed
sudo systemctl restart holiday-display
```

## Check it came up clean

```bash
sudo systemctl status holiday-display
journalctl -u holiday-display -f
```

Runs on port 4173 by default (set in the unit file's `Environment=PORT=...`).
