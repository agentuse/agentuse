import readline from 'readline';

/**
 * Output verbosity levels
 */
export enum OutputVerbosity {
  MINIMAL = 0,  // Only results and errors
  COMPACT = 1,  // Default: Summary info only
  NORMAL = 2,   // Current --quiet level
  VERBOSE = 3,  // Current default level
  DEBUG = 4     // Current --debug level (includes all debug logs)
}

export interface VerbosityChangeEvent {
  previous: OutputVerbosity;
  current: OutputVerbosity;
  isDebug: boolean;
}

/**
 * Manages output verbosity and keyboard shortcuts
 */
export class VerbosityManager {
  private static instance: VerbosityManager;
  private currentVerbosity: OutputVerbosity = OutputVerbosity.COMPACT;
  private debugMode: boolean = false;
  private keyboardEnabled: boolean = false;
  private listeners: Array<(event: VerbosityChangeEvent) => void> = [];
  private rawMode: boolean = false;

  private constructor() {}

  static getInstance(): VerbosityManager {
    if (!VerbosityManager.instance) {
      VerbosityManager.instance = new VerbosityManager();
    }
    return VerbosityManager.instance;
  }

  /**
   * Initialize keyboard shortcuts (Ctrl-O for verbosity, Ctrl-D for debug)
   */
  enableKeyboardShortcuts(): void {
    if (!process.stdin.isTTY || this.keyboardEnabled) {
      return;
    }

    this.keyboardEnabled = true;

    // Enable raw mode to capture keypresses
    try {
      readline.emitKeypressEvents(process.stdin);

      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        this.rawMode = true;
      }

      process.stdin.on('keypress', this.handleKeypress.bind(this));

      // Handle cleanup on exit
      const cleanup = () => {
        this.disableKeyboardShortcuts();
      };

      process.on('exit', cleanup);
      process.on('SIGINT', () => {
        cleanup();
        process.exit(130); // Standard exit code for SIGINT
      });
    } catch (error) {
      // Silently fail if we can't setup keyboard shortcuts
      this.keyboardEnabled = false;
    }
  }

  /**
   * Disable keyboard shortcuts and restore normal mode
   */
  disableKeyboardShortcuts(): void {
    if (!this.keyboardEnabled) {
      return;
    }

    this.keyboardEnabled = false;

    if (this.rawMode && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
        this.rawMode = false;
      } catch (error) {
        // Ignore errors during cleanup
      }
    }

    try {
      process.stdin.removeAllListeners('keypress');
    } catch (error) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Handle keypress events
   */
  private handleKeypress(_str: string, key: any): void {
    if (!key) {
      return;
    }

    // Ctrl-O: Cycle through verbosity levels
    if (key.ctrl && key.name === 'o') {
      this.cycleVerbosity();
    }

    // Ctrl-D: Toggle debug mode
    else if (key.ctrl && key.name === 'd') {
      // Don't toggle debug if this is EOF on empty input
      // Only toggle if we're in the middle of execution
      if (!process.stdin.isRaw) {
        return;
      }
      this.toggleDebug();
    }

    // Ctrl-C: Allow normal termination
    else if (key.ctrl && key.name === 'c') {
      this.disableKeyboardShortcuts();
      process.exit(130);
    }
  }

  /**
   * Cycle to next verbosity level
   */
  cycleVerbosity(): void {
    const previous = this.currentVerbosity;

    // Cycle through levels: MINIMAL -> COMPACT -> NORMAL -> VERBOSE -> MINIMAL
    // Skip DEBUG as it's controlled by toggleDebug()
    const levels = [
      OutputVerbosity.MINIMAL,
      OutputVerbosity.COMPACT,
      OutputVerbosity.NORMAL,
      OutputVerbosity.VERBOSE,
    ];

    const currentIndex = levels.indexOf(this.currentVerbosity);
    const nextIndex = (currentIndex + 1) % levels.length;
    this.currentVerbosity = levels[nextIndex];

    this.notifyListeners({ previous, current: this.currentVerbosity, isDebug: this.debugMode });
  }

  /**
   * Toggle debug mode
   */
  toggleDebug(): void {
    const previous = this.currentVerbosity;
    this.debugMode = !this.debugMode;

    // When enabling debug, ensure we're at least at VERBOSE level
    if (this.debugMode && this.currentVerbosity < OutputVerbosity.VERBOSE) {
      this.currentVerbosity = OutputVerbosity.VERBOSE;
    }

    this.notifyListeners({ previous, current: this.currentVerbosity, isDebug: this.debugMode });
  }

  /**
   * Set verbosity level programmatically
   */
  setVerbosity(level: OutputVerbosity): void {
    const previous = this.currentVerbosity;
    this.currentVerbosity = level;

    // If setting to DEBUG level, enable debug mode
    if (level === OutputVerbosity.DEBUG) {
      this.debugMode = true;
    }

    this.notifyListeners({ previous, current: this.currentVerbosity, isDebug: this.debugMode });
  }

  /**
   * Set debug mode programmatically
   */
  setDebugMode(enabled: boolean): void {
    const previous = this.currentVerbosity;
    this.debugMode = enabled;

    // When enabling debug, ensure we're at least at VERBOSE level
    if (enabled && this.currentVerbosity < OutputVerbosity.VERBOSE) {
      this.currentVerbosity = OutputVerbosity.VERBOSE;
    }

    this.notifyListeners({ previous, current: this.currentVerbosity, isDebug: this.debugMode });
  }

  /**
   * Get current verbosity level
   */
  getVerbosity(): OutputVerbosity {
    return this.currentVerbosity;
  }

  /**
   * Get debug mode status
   */
  isDebugMode(): boolean {
    return this.debugMode;
  }

  /**
   * Get effective verbosity (DEBUG if debug mode is on)
   */
  getEffectiveVerbosity(): OutputVerbosity {
    return this.debugMode ? OutputVerbosity.DEBUG : this.currentVerbosity;
  }

  /**
   * Check if a message should be shown at current verbosity level
   */
  shouldShow(requiredLevel: OutputVerbosity): boolean {
    return this.getEffectiveVerbosity() >= requiredLevel;
  }

  /**
   * Register a listener for verbosity changes
   */
  onChange(callback: (event: VerbosityChangeEvent) => void): void {
    this.listeners.push(callback);
  }

  /**
   * Remove a verbosity change listener
   */
  offChange(callback: (event: VerbosityChangeEvent) => void): void {
    const index = this.listeners.indexOf(callback);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Notify all listeners of verbosity changes
   */
  private notifyListeners(event: VerbosityChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // Silently ignore listener errors
      }
    }
  }

  /**
   * Get verbosity level name
   */
  getVerbosityName(level?: OutputVerbosity): string {
    const l = level ?? this.getEffectiveVerbosity();
    switch (l) {
      case OutputVerbosity.MINIMAL:
        return 'MINIMAL';
      case OutputVerbosity.COMPACT:
        return 'COMPACT';
      case OutputVerbosity.NORMAL:
        return 'NORMAL';
      case OutputVerbosity.VERBOSE:
        return 'VERBOSE';
      case OutputVerbosity.DEBUG:
        return 'DEBUG';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.disableKeyboardShortcuts();
    this.listeners = [];
  }
}

// Export singleton instance
export const verbosityManager = VerbosityManager.getInstance();
