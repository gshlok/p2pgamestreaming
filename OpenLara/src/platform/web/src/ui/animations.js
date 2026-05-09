/**
 * Animations Utility System
 * Physical, restrained, intentional motion.
 */

export const Animations = {
  /**
   * Smoothly interpolates a number and updates an element's text.
   * Useful for counting metrics.
   */
  animateNumber(element, start, end, duration = 800, formatter = (v) => Math.floor(v)) {
    if (!element) return;
    
    const startTime = performance.now();
    
    const update = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Easing: cubic out
      const ease = 1 - Math.pow(1 - progress, 3);
      
      const current = start + (end - start) * ease;
      element.textContent = formatter(current);
      
      if (progress < 1) {
        requestAnimationFrame(update);
      }
    };
    
    requestAnimationFrame(update);
  },

  /**
   * Formats bytes into a human-readable string.
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
};
