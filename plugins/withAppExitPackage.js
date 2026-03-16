// Expo config plugin to add AppExitPackage to MainApplication.java
// This runs during prebuild and modifies the generated MainApplication
const { withMainApplication } = require('@expo/config-plugins');

function withAppExitPackage(config) {
    return withMainApplication(config, (config) => {
        let contents = config.modResults.contents;

        // Add import for AppExitPackage
        if (!contents.includes('AppExitPackage')) {
            // Add import after the last import statement
            contents = contents.replace(
                /(import .+\n)(?!import )/,
                '$1import com.oriontv.AppExitPackage\n'
            );

            // Add package to getPackages() list
            // The pattern in Expo-generated MainApplication is:
            // packages.add(new ...Package())  or  packages.add(AppExitPackage())
            // We need to add our package after PackageList
            if (contents.includes('PackageList(this).packages')) {
                contents = contents.replace(
                    'PackageList(this).packages',
                    'PackageList(this).packages.apply { add(AppExitPackage()) }'
                );
            } else if (contents.includes('PackageList(this).getPackages()')) {
                contents = contents.replace(
                    'PackageList(this).getPackages()',
                    'PackageList(this).getPackages().apply { add(AppExitPackage()) }'
                );
            }
        }

        config.modResults.contents = contents;
        return config;
    });
}

module.exports = withAppExitPackage;
