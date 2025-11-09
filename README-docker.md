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

## Important: Volume Mounting for Hardlinks

**Critical consideration when mounting paths:** This application creates hardlinks between your source files and output directories. Due to how Docker handles volume mounts, you must structure your mounts carefully:

### The Problem
Linux (and Docker) does not allow hardlinks across different filesystems. When you mount multiple paths in Docker, **each mount is treated as a separate filesystem** - even if they're all on the same physical drive on your host machine. This means hardlinks will fail between separately mounted paths.

### The Solution
You have two options:

1. **Mount a common parent directory (Recommended)**
   ```powershell
   docker run -p 5173:5173 \
     -v D:\Media:/media \
     --rm --name mmp-renamer mmp-renamer:latest
   ```
   This approach mounts a single parent directory that contains both your input and output paths. For example, if your structure is:
   - Input: `D:\Media\Downloads\Anime`
   - Output: `D:\Media\Jellyfin\Anime`
   
   Mount `D:\Media` and configure paths inside the container as `/media/Downloads/Anime` and `/media/Jellyfin/Anime`. This keeps everything under one filesystem mount.

2. **Mount the entire drive (Less recommended)**
   ```powershell
   docker run -p 5173:5173 \
     -v D:\:/data \
     --rm --name mmp-renamer mmp-renamer:latest
   ```
   This gives you maximum flexibility but exposes your entire drive to the container.

### What NOT to do
```powershell
# ❌ This will NOT work for hardlinks:
docker run -p 5173:5173 \
  -v D:\Media\Downloads:/downloads \
  -v D:\Media\Jellyfin:/output \
  --rm --name mmp-renamer mmp-renamer:latest
```
Even though both paths are on the same `D:\` drive, they become separate filesystems inside Docker and hardlinks between them will fail.

Notes:
- The `web/dist` static assets are built during the Docker image build (multi-stage). If you change frontend code locally, rebuild the image.
