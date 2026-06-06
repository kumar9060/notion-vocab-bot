# Daily Notion Vocabulary Bot for UPSC

This repository contains an automated script that publishes 10 curated vocabulary words from The Hindu editorial and UPSC relevant topics to your Notion page every morning at 7:00 AM IST (1:30 AM UTC).

## Features
- **Zero Local Run**: Powered entirely by GitHub Actions. Runs in the cloud without requiring your laptop to be active.
- **UPSC/The Hindu Context**: Focused on words, usage in GS/Essay papers, editorial relevance, Hindi meanings, mnemonics, and etymology.
- **Notion Integration**: Creates a beautifully formatted date-based page every day.

## How to Set It Up on Your GitHub

1. **Create a new GitHub Repository**:
   - Go to [GitHub](https://github.com) and create a new repository (private or public). Let's call it `notion-vocab-bot`.

2. **Initialize git and push the files**:
   Run the following commands in this directory:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of Notion Vocab Bot"
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/notion-vocab-bot.git
   git push -u origin main
   ```

3. **Configure GitHub Secrets**:
   Go to your GitHub repository:
   - Click **Settings** (top tabs) -> **Secrets and variables** -> **Actions**.
   - Click **New repository secret** and add:
     - Name: `NOTION_TOKEN`
     - Value: `ntn_TT507387130FhhFuGCDMAXgTopEDM5RBUen7t0HzV3I2b7`
   - Click **New repository secret** again and add:
     - Name: `NOTION_PARENT_PAGE_ID`
     - Value: `36801e3e-1cfa-8019-a9e0-fccb947f45f8`

4. **Verify / Run Manually**:
   - Go to the **Actions** tab in your GitHub repository.
   - Select **Daily Notion Vocabulary Update** on the left.
   - Click **Run workflow** -> **Run workflow** (branch: `main`).
   - This will trigger the script instantly so you can verify the output on Notion!
