# Docker build/run

This repository includes a Dockerfile that builds the web frontend and runs the Node server.

Build image (from project root):

```powershell
# build the docker image
docker build -t mmp-renamer:latest .
```

Run container (map port 5173):

```powershell
docker run -p 5173:5173 --rm --name mmp-renamer mmp-renamer:latest
```

Notes:
- The `web/dist` static assets are built during the Docker image build (multi-stage). If you change frontend code locally, rebuild the image.
