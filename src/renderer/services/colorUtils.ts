import { RGB, RGBW } from '../types';

/**
 * Approximates RGBW from RGB. 
 * This is a simple algorithm assuming the White LED is a cool/neutral white.
 * It subtracts the common minimum value from RGB and moves it to W.
 */
export const rgbToRgbw = (r: number, g: number, b: number): RGBW => {
  // Simple "Subtract Min" algorithm to extract white
  const minVal = Math.min(r, g, b);
  
  // This factor determines how aggressively we move color to the white channel.
  // 1.0 means fully subtracting the grey component.
  const factor = 1.0; 

  return {
    r: Math.floor(r - (minVal * factor)),
    g: Math.floor(g - (minVal * factor)),
    b: Math.floor(b - (minVal * factor)),
    w: Math.floor(minVal * factor)
  };
};

export const getColorString = (c: RGBW) => `rgb(${c.r}, ${c.g}, ${c.b})`;
export const getFullColorString = (c: RGBW) => `rgba(${c.r}, ${c.g}, ${c.b}, 1)`;