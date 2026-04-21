export interface WSPRSpot {
  datetime: string;
  transmitter: string;
  reporter: string;
  snr: number;
  power: number;
  tx_lat: number;
  tx_lon: number;
  rx_lat: number;
  rx_lon: number;
  azimuth: number;
  snr_norm?: number;
  isMatch?: boolean;
  matchedSNR?: number;
  distance?: number;
}

export interface ProcessedData {
  spots: WSPRSpot[];
  deltaG: number | null;
  timeSeriesData: any[];
  polarData: any[];
  mapLines: any[];
  countA: number;
  countB: number;
  scatterData: { distance: number; snrA: number | null; snrB: number | null }[];
  regressionA: { m: number; b: number } | null;
  regressionB: { m: number; b: number } | null;
  propagationNote: string | null;
  avgPowerA: number | null;
  avgPowerB: number | null;
  warnings: {
    lowDataDx: boolean;
    lowDataLocal: boolean;
  };
}
