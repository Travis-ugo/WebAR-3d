/**
 * Hey May! This is our Node.js Server script for the 3D Model Tracking project.
 * 
 * Why do we need a custom server instead of just opening index.html directly on our laptop?
 * 
 * 1. Mobile Camera Security (HTTPS):
 *    May, modern mobile browsers (like iOS Safari or Android Chrome) block webcam access completely 
 *    unless the page is served over a secure, encrypted connection (HTTPS). The only exception is 
 *    'localhost' on a desktop. To test this on your phone, our server has to use HTTPS.
 * 
 * 2. Serving 3D models with correct headers:
 *    This server supports loading modern 3D model formats (.gltf and .glb) using correct mime types 
 *    so the browser parses them correctly.
 * 
 * This Node.js script spins up both servers natively without requiring heavy backend frameworks!
 */

// ============================================================================
// 1. MODULE IMPORTS (Core Node.js Built-in Libraries)
// ============================================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ============================================================================
// 2. EXTERNAL LIBRARIES (Installed via npm install)
// ============================================================================
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

// ============================================================================
// 3. PORT CONFIGURATION
// ============================================================================
const PORT_HTTPS = 3030; // Secure port. Point your mobile phone browser to this port.
const PORT_HTTP = 8080;  // Fallback unsecured port. Use this for quick previewing on your laptop.

// Resolve the absolute file paths on disk for the SSL/TLS private key and certificate files.
const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');

// ============================================================================
// 4. AUTOMATIC SSL/TLS CERTIFICATE GENERATION:
// Checks for self-signed certificates. If missing, runs OpenSSL natively to create them.
// ============================================================================
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.log('Generating self-signed SSL/TLS certificates for HTTPS camera access on smartphones...');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 365 -nodes -subj "/CN=localhost"`,
      { stdio: 'inherit' }
    );
    console.log('Certificates generated successfully (key.pem, cert.pem).\n');
  } catch (error) {
    console.error('Failed to generate SSL certificates natively. Please check if openssl is installed.', error);
    process.exit(1);
  }
}

// ============================================================================
// 5. LOCAL IP NETWORK RESOLUTION:
// Resolves your computer's local Wi-Fi IP address.
// This allows you to type the URL (e.g. https://192.168.1.15:3030) on your phone.
// ============================================================================
function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name in interfaces) {
    for (const netInterface of interfaces[name]) {
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        addresses.push(netInterface.address);
      }
    }
  }
  return addresses;
}

const localIPs = getLocalIPAddresses();

// ============================================================================
// 6. MIME TYPES MAP:
// Tells the browser what kind of file is being transmitted so it knows how to execute/display it.
// ============================================================================
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mind': 'application/octet-stream', // Binary compiled target features signature file
  '.gltf': 'model/gltf+json',          // glTF 3D model format (JSON based)
  '.glb': 'model/gltf-binary'          // GLB 3D model format (compiled binary)
};

// ============================================================================
// 7. THE MAIN REQUEST HANDLER:
// This function runs every single time a web browser requests a page or file.
// ============================================================================
function handleRequest(req, res) {
  // Strip query parameters (like ?autostart=true) before resolving the file path
  const urlPath = req.url.split('?')[0];
  const decodedUrl = decodeURI(urlPath);
  
  // Custom routing dispatch
  let filePath;
  if (decodedUrl === '/' || decodedUrl === '') {
    filePath = path.join(__dirname, 'index.html');
  } else if (decodedUrl === '/preview') {
    filePath = path.join(__dirname, 'preview.html');
  } else {
    filePath = path.join(__dirname, decodedUrl);
  }
  
  // Security guard against Directory Traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Support range requests (particularly for any video elements or media streaming if added later)
  if (contentType === 'video/mp4' && req.headers.range) {
    const range = req.headers.range;
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
}

// ============================================================================
// 8. FIRE UP THE SERVERS:
// We launch two servers simultaneously to support local and mobile testing.
// ============================================================================

// A. SECURE HTTPS SERVER:
const sslOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
};

const httpsServer = https.createServer(sslOptions, handleRequest);
httpsServer.listen(PORT_HTTPS, () => {
  console.log('==================================================');
  console.log(`🔒 Secure HTTPS Server (Mobile Testing) running:`);
  console.log(`   On Laptop:  https://localhost:${PORT_HTTPS}`);
  localIPs.forEach(ip => {
    const mobileUrl = `https://${ip}:${PORT_HTTPS}`;
    console.log(`   On Mobile:  ${mobileUrl}`);
    console.log(`   Scan the QR code below to open this URL directly on your phone:`);
    qrcodeTerminal.generate(mobileUrl, { small: true });

    const qrImagePath = path.join(__dirname, 'qrcode.png');
    QRCode.toFile(qrImagePath, mobileUrl, {
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 512
    }, (err) => {
      if (err) {
        console.error('   [ERROR] Failed to save QR code picture:', err);
      } else {
        console.log(`   [SUCCESS] QR Code picture generated and saved to: ${qrImagePath}`);
      }
    });
  });
  console.log('==================================================');
  console.log('💡 Note: When loading on your smartphone, you will see a certificate warning.');
  console.log('   Simply tap "Advanced" -> "Proceed anyway" to bypass it.');
  console.log('   (Self-signed certificate is completely safe for local development)');
  console.log('==================================================\n');
});

// B. NON-SECURE HTTP SERVER:
const httpServer = http.createServer(handleRequest);
httpServer.listen(PORT_HTTP, () => {
  console.log(`🔌 HTTP Preview Server running at http://localhost:${PORT_HTTP}\n`);
});
