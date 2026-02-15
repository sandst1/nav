# Release Process

## One-Time Setup

Update your GitHub repository references:

```bash
# Set your GitHub username
GITHUB_USER="your-username"

# Update install.sh and README.md
sed -i '' "s/YOUR_USERNAME/$GITHUB_USER/g" install.sh README.md

# Commit
git add install.sh README.md
git commit -m "Update GitHub repository references"
git push origin main
```

## Creating a Release

### 1. Ensure all changes are committed

```bash
git status  # Should be clean
```

### 2. Bump version and create tag

```bash
# Choose one:
npm version patch  # 0.1.0 → 0.1.1
npm version minor  # 0.1.0 → 0.2.0
npm version major  # 0.1.0 → 1.0.0
```

This automatically creates a git commit and tag.

### 3. Push to GitHub

```bash
git push origin main --tags
```

### 4. Wait for builds

GitHub Actions will automatically:
- Build binaries for macOS (x64/ARM64), Linux (x64/ARM64), Windows (x64)
- Create tarballs/zips with SHA256 checksums
- Publish a GitHub Release with all assets

Monitor at: `https://github.com/YOUR_USERNAME/nav/actions`

### 5. Test installation

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/nav/main/install.sh | bash
nav --help
```

## Testing Locally Before Release

```bash
# Build for your platform
bun run build:darwin-arm64  # or linux-x64, windows-x64, etc.

# Test the binary
./dist/nav-darwin-arm64 --help
```

## Troubleshooting

**Build fails:**
- Check Actions logs at `https://github.com/YOUR_USERNAME/nav/actions`
- Ensure all files are committed and pushed

**Install script fails:**
- Verify the tag was pushed: `git push --tags`
- Check the release exists in GitHub Releases
- Ensure repository is public

That's it! 🚀
