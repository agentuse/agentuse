// electron-builder invokes this hook after signing. It deliberately no-ops for
// local unsigned builds; CI can provide the Apple credentials to notarize.
exports.default = async function notarize(context) {
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) return;
  const { notarize } = require("@electron/notarize");
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
