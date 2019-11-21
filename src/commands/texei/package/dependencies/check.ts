import { flags, SfdxCommand } from '@salesforce/command';
import { JsonArray, JsonMap } from '@salesforce/ts-types';
import { Messages, SfdxProjectJson } from '@salesforce/core';
const spawn = require('child-process-promise').spawn;

const packageIdPrefix = '0Ho';
const packageVersionIdPrefix = '04t';
const packageAliasesMap = [];

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages('texei-sfdx-plugin', 'package-dependencies-install');

export default class Install extends SfdxCommand {

  public static description = messages.getMessage('commandDescription');

  public static examples = [
    '$ texei:package:dependencies:check -u MyScratchOrg -v MyDevHub -b "DEV"'
  ];

  protected static flagsConfig = {
    branch: flags.string({ char: 'b', required: false, description: 'the package version’s branch' }),
    packages: flags.string({ char: 'p', required: false, description: "comma-separated list of the packages to install related dependencies" }),
    namespaces: flags.string({ char: 'n', required: false, description: 'filter package installation by namespace' }),
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  // Comment this out if your command does not require a hub org username
  protected static requiresDevhubUsername = true;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = true;

  public async run(): Promise<any> {

    const result = { installedPackages: {} };

    const username = this.org.getUsername();
    const options = SfdxProjectJson.getDefaultOptions();
    const project = await SfdxProjectJson.create(options);

    if (this.flags.packages != null) {
      this.ux.log('Filtering by packages: ' + this.flags.packages);
    }

    if (this.flags.namespaces != null) {
      this.ux.log('Filtering by namespaces: ' + this.flags.namespaces);
    }

    const packageAliases = project.get('packageAliases') || {};
    if (typeof packageAliases !== undefined) {

      Object.entries(packageAliases).forEach(([key, value]) => {
        packageAliasesMap[key] = value;
      });
    }

    // Getting Package
    const packagesToInstall = [];

    const packageDirectories = project.get('packageDirectories') as JsonArray || [];
    const packages = new Set();
    if (this.flags.packages) {
      for (let pkg of this.flags.packages.split(',')) {
        packages.add(pkg.trim());
      }
    }

    //see if no filter is true
    const packagesNoFilter = (this.flags.packages == null);;

    this.ux.startSpinner('Resolving dependencies');

    for (let packageDirectory of packageDirectories) {
      packageDirectory = packageDirectory as JsonMap;
      const packageName = (packageDirectory.package && packageDirectory.package.toString()) ? packageDirectory.package.toString() : '';

      // If the package is found, or if there isn't any package filtering
      if (packages.has(packageName) || packagesNoFilter) {

        const dependencies = packageDirectory.dependencies || [];

        // TODO: Move all labels to message
        if (dependencies && dependencies[0] !== undefined) {
          this.ux.log(`Package dependencies found for package directory ${packageDirectory.path}`);
          for (const dependency of (dependencies as JsonArray)) {

            const packageInfo = {} as JsonMap;

            const dependencyInfo = dependency as JsonMap;
            const dependentPackage: string = ((dependencyInfo.packageId != null) ? dependencyInfo.packageId : dependencyInfo.package) as string;
            const versionNumber: string = (dependencyInfo.versionNumber) as string;
            const namespaces: string[] = this.flags.namespaces !== undefined ? this.flags.namespaces.split(',') : null;

            if (dependentPackage == null) {
              throw Error('Dependent package version unknow error.');
            }

            packageInfo.dependentPackage = dependentPackage;
            packageInfo.versionNumber = versionNumber;
            const packageVersionId = await this.getPackageVersionId(dependentPackage, versionNumber, namespaces);
            if (packageVersionId != null) {
              packageInfo.packageVersionId = packageVersionId;
              packagesToInstall.push(packageInfo);
              this.ux.log(`    ${packageInfo.packageVersionId} : ${packageInfo.dependentPackage}${packageInfo.versionNumber === undefined ? '' : ' ' + packageInfo.versionNumber}`);
            }
          }
        } else {
          this.ux.log(`No dependencies found for package directory ${packageDirectory.path}`);
        }

        // Removing package from packages flag list --> Used later to log if one of them wasn't found
        if (packages && packages.has(packageName)) {
          packages.delete(packageName);
        }
      }
    }

    // In case one package wasn't found when filtering by packages
    if (packages && packages.size > 0) {
      this.ux.log(`Following packages were used in the --packages flag but were not found in the packageDirectories:`);

      for (let packageName of packages) {
        this.ux.log(`    ${packageName}`);
      }
    }

    this.ux.stopSpinner('Done.');

    if (packagesToInstall.length > 0) { // Installing Packages

      // Getting currently installed packages
      let installedPackages;
      const installedArgs = [];
      installedArgs.push('force:package:installed:list');
      installedArgs.push('--targetusername');
      installedArgs.push(`${username}`);
      installedArgs.push('--json');

      var promise = spawn('sfdx', installedArgs);
      var childProcess = promise.childProcess;

      childProcess.stdout.on('data', function (data) {
        installedPackages = JSON.parse(data.toString());
      });
      await promise;

      for (let packageInfo of packagesToInstall) {
        packageInfo = packageInfo as JsonMap;

        var installedPackage = installedPackages["result"].find(obj => {
          return obj["SubscriberPackageVersionId"] == packageInfo.packageVersionId;
        });

        if (installedPackage == null) {
          this.ux.log(`Package ${packageInfo.packageVersionId} : ${packageInfo.dependentPackage}${packageInfo.versionNumber === undefined ? '' : ' ' + packageInfo.versionNumber} is not installed please run texei:package:dependencies:install to install`);
        } else {
          this.ux.log(`Package ${packageInfo.packageVersionId} : ${packageInfo.dependentPackage}${packageInfo.versionNumber === undefined ? '' : ' ' + packageInfo.versionNumber} is already installed`);
        }
      }
    }

    return { message: result };
  }

  private async getPackageVersionId(name: string, version: string, namespaces: string[]) {

    let packageId = null;
    // Keeping original name so that it can be used in error message if needed
    let packageName = name;

    // TODO: Some stuff are duplicated here, some code don't need to be executed for every package
    // First look if it's an alias
    if (typeof packageAliasesMap[packageName] !== 'undefined') {
      packageName = packageAliasesMap[packageName];
    }

    if (packageName.startsWith(packageVersionIdPrefix)) {
      // Package2VersionId is set directly
      packageId = packageName;
    } else if (packageName.startsWith(packageIdPrefix)) {
      // Get Package version id from package + versionNumber
      const vers = version.split('.');
      let query = 'Select SubscriberPackageVersionId, IsPasswordProtected, IsReleased, Package2.NamespacePrefix ';
      query += 'from Package2Version ';
      query += `where Package2Id='${packageName}' and MajorVersion=${vers[0]} and MinorVersion=${vers[1]} and PatchVersion=${vers[2]} `;

      if (namespaces != null) {
        query += ` and Package2.NamespacePrefix IN ('${namespaces.join('\',\'')}')`;
      }

      // If Build Number isn't set to LATEST, look for the exact Package Version
      if (vers[3] !== 'LATEST') {
        query += `and BuildNumber=${vers[3]} `;
      }

      // If Branch is specified, use it to filter
      if (this.flags.branch) {
        query += `and Branch='${this.flags.branch.trim()}' `;
      }

      query += ' ORDER BY BuildNumber DESC Limit 1';

      // Query DevHub to get the expected Package2Version
      const conn = this.hubOrg.getConnection();
      const resultPackageId = await conn.tooling.query(query) as any;

      if (resultPackageId.size > 0) {
        packageId = resultPackageId.records[0].SubscriberPackageVersionId;
      }
    }

    return packageId;
  }
}
