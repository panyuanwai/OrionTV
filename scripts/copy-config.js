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

console.log('Copying xml/ AndroidManifest to android/app/src/main/ ...');
copyDir(path.join(__dirname, '../xml'), path.join(__dirname, '../android/app/src/main'));

// After copying xml/ (which copied main/ into main/), we need to move the nested contents up and delete the nested folder
const nestedMainPath = path.join(__dirname, '../android/app/src/main/main');
if (fs.existsSync(nestedMainPath)) {
    console.log('Found nested main/ folder, elevating contents...');
    copyDir(nestedMainPath, path.join(__dirname, '../android/app/src/main'));
    fs.rmSync(nestedMainPath, { recursive: true, force: true });
}
console.log('Copy complete.');
