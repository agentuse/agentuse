const TYPESCRIPT_LIB_DECLARATION = /(?:^|[\\/])typescript[\\/]lib[\\/]lib(?:\.[a-z0-9]+)*\.d\.ts$/;

/**
 * electron-builder normally removes every declaration file from production
 * dependencies. AgentUse loads TypeScript's standard libraries at runtime for
 * Code Mode preflight, so force-include only that required declaration family.
 */
exports.onNodeModuleFile = function onNodeModuleFile(filePath) {
  return TYPESCRIPT_LIB_DECLARATION.test(filePath) || undefined;
};
