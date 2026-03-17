const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
            console.log(`Copied ${srcPath} -> ${destPath}`);
        }
    }
}

console.log('Copying xml/ to android/app/src/main/ ...');
copyDir(path.join(__dirname, '../xml'), path.join(__dirname, '../android/app/src/main'));
console.log('Copy complete.');
