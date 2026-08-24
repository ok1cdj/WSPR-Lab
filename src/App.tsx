/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Brush,
  ScatterChart, Scatter, ZAxis, ReferenceLine, ComposedChart
} from 'recharts';
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup } from 'react-leaflet';
import { format, parseISO, startOfMinute } from 'date-fns';
import { 
  Settings, Activity, Map as MapIcon, Radio, 
  ChevronRight, RefreshCw, AlertCircle, Info,
  Compass, Table as TableIcon, CheckCircle2,
  Menu, X, Mail, Coffee, Download
} from 'lucide-react';
import { cn } from './lib/utils';
import { WSPRSpot, ProcessedData } from './types';
import { Analytics } from "@vercel/analytics/react";

// --- Helpers ---
function getGreatCirclePath(lat1: number, lon1: number, lat2: number, lon2: number, points = 25) {
  if (lat1 === lat2 && lon1 === lon2) return [[lat1, lon1], [lat2, lon2]];
  
  const path: [number, number][] = [];
  const toRad = (deg: number) => deg * Math.PI / 180;
  const toDeg = (rad: number) => rad * 180 / Math.PI;

  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);

  const d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((φ1 - φ2) / 2), 2) + Math.cos(φ1) * Math.cos(φ2) * Math.pow(Math.sin((λ1 - λ2) / 2), 2)));

  if (d === 0) return [[lat1, lon1], [lat2, lon2]];

  for (let i = 0; i <= points; i++) {
    const f = i / points;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2)));
    const λ = Math.atan2(y, x);
    path.push([toDeg(φ), toDeg(λ)]);
  }
  return path;
}

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (deg: number) => deg * Math.PI / 180;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((φ1 - φ2) / 2), 2) + Math.cos(φ1) * Math.cos(φ2) * Math.pow(Math.sin((λ1 - λ2) / 2), 2)));
  return d * 6371;
}

function getBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (deg: number) => deg * Math.PI / 180;
  const toDeg = (rad: number) => rad * 180 / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// --- Constants ---
const APP_VERSION = 'v1.4.0';

// Time-series bucket size (10 minutes) used for grouping spots and brush filtering.
const TIME_BUCKET_MS = 10 * 60 * 1000;

const BANDS = [
  { label: '160m', value: '1' },
  { label: '80m', value: '3' },
  { label: '60m', value: '5' },
  { label: '40m', value: '7' },
  { label: '30m', value: '10' },
  { label: '20m', value: '14' },
  { label: '17m', value: '18' },
  { label: '15m', value: '21' },
  { label: '12m', value: '24' },
  { label: '10m', value: '28' },
];

const TIME_WINDOWS = [
  { label: 'Last Hour', value: 1 },
  { label: 'Last 3 Hours', value: 3 },
  { label: 'Last 6 Hours', value: 6 },
  { label: 'Last 12 Hours', value: 12 },
  { label: 'Last 24 Hours', value: 24 },
];

export default function App() {
  // --- State ---
  const [viewMode, setViewMode] = useState<'TX' | 'RX'>('TX');
  const [callA, setCallA] = useState(() => localStorage.getItem('wspr_callA') || 'OK1CDJ');
  const [callB, setCallB] = useState(() => localStorage.getItem('wspr_callB') || '');
  const [band, setBand] = useState(() => localStorage.getItem('wspr_band') || '14');
  const [hours, setHours] = useState(() => Number(localStorage.getItem('wspr_hours')) || 3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawData, setRawData] = useState<any[]>([]);
  const [nearbyStations, setNearbyStations] = useState<any[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [nearbyError, setNearbyError] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [brushRange, setBrushRange] = useState<{ startIndex?: number; endIndex?: number }>({});
  const [beamwidth, setBeamwidth] = useState(() => Number(localStorage.getItem('wspr_beamwidth')) || 30);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'datetime', direction: 'desc' });
  const [showOnlyMatches, setShowOnlyMatches] = useState(false);
  const [localThreshold, setLocalThreshold] = useState(() => Number(localStorage.getItem('wspr_local_threshold')) || 1500);
  const [dxThreshold, setDxThreshold] = useState(() => Number(localStorage.getItem('wspr_dx_threshold')) || 4000);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  useEffect(() => {
    setBrushRange({});
  }, [rawData]);

  // --- Persistence ---
  useEffect(() => {
    localStorage.setItem('wspr_callA', callA);
    localStorage.setItem('wspr_callB', callB);
    localStorage.setItem('wspr_band', band);
    localStorage.setItem('wspr_hours', hours.toString());
    localStorage.setItem('wspr_beamwidth', beamwidth.toString());
    localStorage.setItem('wspr_local_threshold', localThreshold.toString());
    localStorage.setItem('wspr_dx_threshold', dxThreshold.toString());
  }, [callA, callB, band, hours, beamwidth, localThreshold, dxThreshold]);

  // --- Fetch Nearby Stations ---
  const fetchNearby = async () => {
    if (!callA || callA.length < 3) {
      setNearbyStations([]);
      return;
    }
    setLoadingNearby(true);
    setNearbyError(false);
    try {
      const response = await fetch('/api/nearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callA, band, viewMode }),
      });
      if (!response.ok) throw new Error('Failed to fetch nearby stations');
      const data = await response.json();
      
      // Safety filter for unique callsigns
      const unique = (data.stations || []).reduce((acc: any[], curr: any) => {
        if (!acc.find(s => s.tx_sign === curr.tx_sign)) {
          acc.push(curr);
        }
        return acc;
      }, []);
      
      setNearbyStations(unique);
    } catch (err) {
      console.error(err);
      setNearbyError(true);
    } finally {
      setLoadingNearby(false);
    }
  };

  useEffect(() => {
    fetchNearby();
  }, [callA, band, viewMode]);

  // --- Data Processing ---
  // --- Data Processing ---

  // 1. All spots with normalization, distance, and match info
  const allProcessedSpots = useMemo((): WSPRSpot[] => {
    if (!rawData || rawData.length === 0) return [];
    
    const base = rawData.map(d => ({
      ...d,
      snr_norm: d.snr - d.power,
      distance: getDistance(d.tx_lat, d.tx_lon, d.rx_lat, d.rx_lon),
      azimuth: viewMode === 'RX' ? getBearing(d.rx_lat, d.rx_lon, d.tx_lat, d.tx_lon) : d.azimuth
    }));

    const spotsByTimeAndPeer: Record<string, Record<string, WSPRSpot>> = {};
    const result: WSPRSpot[] = base.map(s => ({
      ...s,
      isMatch: false,
      matchedSNR: undefined,
      matchedSNRNorm: undefined
    }));

    result.forEach(s => {
      const peer = viewMode === 'TX' ? s.reporter : s.transmitter;
      const target = viewMode === 'TX' ? s.transmitter : s.reporter;
      const key = `${s.datetime}_${peer}`;
      if (!spotsByTimeAndPeer[key]) spotsByTimeAndPeer[key] = {};
      spotsByTimeAndPeer[key][target] = s;
    });

    result.forEach(s => {
      const peer = viewMode === 'TX' ? s.reporter : s.transmitter;
      const target = viewMode === 'TX' ? s.transmitter : s.reporter;
      const key = `${s.datetime}_${peer}`;
      const otherCall = target === callA ? callB : callA;
      if (otherCall && spotsByTimeAndPeer[key][otherCall]) {
        s.isMatch = true;
        s.matchedSNR = spotsByTimeAndPeer[key][otherCall].snr;
        s.matchedSNRNorm = spotsByTimeAndPeer[key][otherCall].snr_norm;
      }
    });

    return result;
  }, [rawData, callA, callB, viewMode]);

  // 2. Base data for visualizations (respecting showOnlyMatches)
  const baseData = useMemo(() => {
    return showOnlyMatches ? allProcessedSpots.filter(s => s.isMatch) : allProcessedSpots;
  }, [allProcessedSpots, showOnlyMatches]);

  // 3. Time Series Data (source for Brush AND used in chart)
  const timeSeriesData = useMemo(() => {
    if (baseData.length === 0) return [];
    // Bucket by absolute timestamp (not clock time) so spots at the same HH:mm on
    // different days stay separate and the series stays chronological across midnight.
    const timeGroups: Record<number, { ts: number, time: string, snrA: number[], snrB: number[] }> = {};
    const upperCallA = callA.toUpperCase();
    const upperCallB = callB.toUpperCase();
    baseData.forEach(s => {
      const ts = Math.floor(parseISO(s.datetime).getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS;
      if (!timeGroups[ts]) timeGroups[ts] = { ts, time: format(new Date(ts), 'HH:mm'), snrA: [], snrB: [] };
      const target = viewMode === 'TX' ? s.transmitter : s.reporter;
      if (target.toUpperCase() === upperCallA) timeGroups[ts].snrA.push(s.snr_norm || 0);
      else if (target.toUpperCase() === upperCallB) timeGroups[ts].snrB.push(s.snr_norm || 0);
    });

    return Object.values(timeGroups)
      .map(g => ({
        ts: g.ts,
        time: g.time,
        [callA]: g.snrA.length > 0 ? Number((g.snrA.reduce((a, b) => a + b, 0) / g.snrA.length).toFixed(1)) : null,
        [callB]: g.snrB.length > 0 ? Number((g.snrB.reduce((a, b) => a + b, 0) / g.snrB.length).toFixed(1)) : null,
      }))
      .sort((a, b) => a.ts - b.ts);
  }, [baseData, callA, callB, viewMode]);

  // 4. Final aggregation with Brush and Sort
  const processed = useMemo((): ProcessedData => {
    if (baseData.length === 0) {
      return { 
        spots: [], 
        deltaG: null, 
        timeSeriesData: [], 
        polarData: [], 
        mapLines: [], 
        countA: 0, 
        countB: 0,
        scatterData: [],
        regressionA: null,
        regressionB: null,
        propagationNote: null,
        avgPowerA: null,
        avgPowerB: null,
        avgDelta: null,
        stdDevDelta: null,
        warnings: { lowDataDx: false, lowDataLocal: false }
      };
    }

    // Filter by Brush
    let filteredSpots = baseData;
    if (brushRange.startIndex !== undefined && brushRange.endIndex !== undefined && timeSeriesData.length > 0) {
      const startTs = timeSeriesData[brushRange.startIndex]?.ts;
      const endTs = timeSeriesData[brushRange.endIndex]?.ts;

      if (startTs !== undefined && endTs !== undefined) {
        filteredSpots = baseData.filter(s => {
          const ts = Math.floor(parseISO(s.datetime).getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS;
          return ts >= startTs && ts <= endTs;
        });
      }
    }

    // Stats
    const upperCallA = callA.toUpperCase();
    const upperCallB = callB.toUpperCase();
    const spotsA = filteredSpots.filter(s => (viewMode === 'TX' ? s.transmitter : s.reporter).toUpperCase() === upperCallA);
    const spotsB = callB ? filteredSpots.filter(s => (viewMode === 'TX' ? s.transmitter : s.reporter).toUpperCase() === upperCallB) : [];
    
    const avgA = spotsA.length > 0 ? spotsA.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / spotsA.length : null;
    const avgB = spotsB.length > 0 ? spotsB.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / spotsB.length : null;
    const deltaG = (avgA !== null && avgB !== null) ? avgA - avgB : null;

    const avgPowerA = spotsA.length > 0 ? spotsA.reduce((acc, s) => acc + s.power, 0) / spotsA.length : null;
    const avgPowerB = spotsB.length > 0 ? spotsB.reduce((acc, s) => acc + s.power, 0) / spotsB.length : null;

    // Delta Stats
    const deltaValues = filteredSpots
      .filter(s => s.isMatch && s.snr_norm !== undefined && s.matchedSNRNorm !== undefined)
      .map(s => {
        const isA = (viewMode === 'TX' ? s.transmitter : s.reporter) === callA;
        return isA ? s.snr_norm! - s.matchedSNRNorm! : s.matchedSNRNorm! - s.snr_norm!;
      });
    
    // We get duplicates because each match has two rows (one for A, one for B).
    // Let's take only the rows for station A to avoid double-counting.
    const uniqueDeltaValues = filteredSpots
      .filter(s => s.isMatch && s.snr_norm !== undefined && s.matchedSNRNorm !== undefined && (viewMode === 'TX' ? s.transmitter : s.reporter) === callA)
      .map(s => s.snr_norm! - s.matchedSNRNorm!);

    let avgDelta: number | null = null;
    let stdDevDelta: number | null = null;
    if (uniqueDeltaValues.length > 0) {
      const sum = uniqueDeltaValues.reduce((a, b) => a + b, 0);
      avgDelta = sum / uniqueDeltaValues.length;
      const variance = uniqueDeltaValues.reduce((a, b) => a + Math.pow(b - avgDelta!, 2), 0) / uniqueDeltaValues.length;
      stdDevDelta = Math.sqrt(variance);
    }

    // Polar Data
    const azimuthBins: Record<number, { azimuth: number, snrA: number[], snrB: number[] }> = {};
    for (let i = 0; i < 360; i += 10) azimuthBins[i] = { azimuth: i, snrA: [], snrB: [] };

    filteredSpots.forEach(s => {
      const bin = Math.floor(s.azimuth / 10) * 10;
      const target = viewMode === 'TX' ? s.transmitter : s.reporter;
      if (azimuthBins[bin]) {
        if (target === callA) azimuthBins[bin].snrA.push(s.snr_norm || 0);
        else if (target === callB) azimuthBins[bin].snrB.push(s.snr_norm || 0);
      }
    });

    const rawAverages = Object.values(azimuthBins).map(b => ({
      azimuth: b.azimuth,
      avgA: b.snrA.length > 0 ? b.snrA.reduce((a, b) => a + b, 0) / b.snrA.length : null,
      avgB: b.snrB.length > 0 ? b.snrB.reduce((a, b) => a + b, 0) / b.snrB.length : null,
      countA: b.snrA.length,
      countB: b.snrB.length
    }));

    const allVals = rawAverages.flatMap(d => [d.avgA, d.avgB]).filter((v): v is number => v !== null);
    let globalMax = 0;
    if (allVals.length > 0) {
      const sorted = [...allVals].sort((a, b) => b - a);
      const topCount = Math.max(1, Math.ceil(sorted.length * 0.05));
      const topVals = sorted.slice(0, topCount);
      globalMax = topVals.reduce((a, b) => a + b, 0) / topCount;
    }

    const sigma = beamwidth / 2.355;
    const smooth = (targetAz: number, data: { azimuth: number, val: number | null }[]) => {
      let numerator = 0.01 * (-40); 
      let denominator = 0.01;
      const validPoints = data.filter(p => p.val !== null);
      if (validPoints.length === 0) return -40;
      validPoints.forEach(p => {
        let diff = Math.abs(targetAz - p.azimuth);
        if (diff > 180) diff = 360 - diff;
        const weight = Math.exp(-(diff * diff) / (2 * sigma * sigma));
        numerator += (p.val! - globalMax) * weight;
        denominator += weight;
      });
      const result = denominator > 0 ? numerator / denominator : -40;
      return Math.min(2, Math.max(-40, Number(result.toFixed(1))));
    };

    const polarData = [];
    for (let i = 0; i < 360; i += 5) {
      const rawBin = rawAverages.find(r => Math.abs(r.azimuth - i) < 2.5);
      polarData.push({
        azimuth: i,
        [callA]: smooth(i, rawAverages.map(r => ({ azimuth: r.azimuth, val: r.avgA }))),
        [callB]: smooth(i, rawAverages.map(r => ({ azimuth: r.azimuth, val: r.avgB }))),
        markerA: rawBin && rawBin.countA > 3 ? 0.5 : null,
        markerB: rawBin && rawBin.countB > 3 ? 0.5 : null,
      });
    }

    // Table Sorting
    const tableSpots = [...filteredSpots].sort((a, b) => {
      let valA: any = a[sortConfig.key as keyof WSPRSpot];
      let valB: any = b[sortConfig.key as keyof WSPRSpot];

      if (sortConfig.key === 'datetime') {
        valA = new Date(valA as string).getTime();
        valB = new Date(valB as string).getTime();
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    // 5. Distance-SNR Correlation & Regression
    const calculateRegression = (data: { x: number; y: number }[]) => {
      const n = data.length;
      if (n < 2) return null;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      data.forEach(p => {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
      });
      const denom = (n * sumX2 - sumX * sumX);
      if (Math.abs(denom) < 0.0001) return null;
      const m = (n * sumXY - sumX * sumY) / denom;
      const b = (sumY - m * sumX) / n;
      return { m, b };
    };

    const scatterDataA = spotsA.map(s => ({ distance: s.distance || 0, snr: s.snr_norm || 0 }));
    const scatterDataB = spotsB.map(s => ({ distance: s.distance || 0, snr: s.snr_norm || 0 }));
    const regressionA = calculateRegression(scatterDataA.map(d => ({ x: d.distance, y: d.snr })));
    const regressionB = calculateRegression(scatterDataB.map(d => ({ x: d.distance, y: d.snr })));

    let propagationNote: string | null = null;
    const warnings = { lowDataDx: false, lowDataLocal: false };

    if (callB && spotsA.length > 0 && spotsB.length > 0) {
      const dxA = spotsA.filter(s => (s.distance || 0) > dxThreshold);
      const dxB = spotsB.filter(s => (s.distance || 0) > dxThreshold);
      const localA = spotsA.filter(s => (s.distance || 0) < localThreshold);
      const localB = spotsB.filter(s => (s.distance || 0) < localThreshold);

      if (dxA.length < 5 || dxB.length < 5) warnings.lowDataDx = true;
      if (localA.length < 5 || localB.length < 5) warnings.lowDataLocal = true;

      const avgDxA = dxA.length > 0 ? dxA.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / dxA.length : -50;
      const avgDxB = dxB.length > 0 ? dxB.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / dxB.length : -50;
      const avgLocalA = localA.length > 0 ? localA.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / localA.length : -50;
      const avgLocalB = localB.length > 0 ? localB.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / localB.length : -50;

      // Antenna favors DX if it loses less signal over distance
      const dropA = avgLocalA - avgDxA;
      const dropB = avgLocalB - avgDxB;

      if (regressionA && regressionB) {
        // Convert slope (dB/km) to dB/1000km for readability (positive value for loss)
        const lossA = Math.abs(regressionA.m * 1000).toFixed(1);
        const lossB = Math.abs(regressionB.m * 1000).toFixed(1);

        // The antenna with the flatter slope (loses less signal over distance) favors DX.
        // The regression slope is the primary, symmetric measure; the local->DX drop is only
        // a tiebreaker for near-equal slopes, and only when every zone has real data (so the
        // -50 empty-zone sentinel above can never decide the verdict).
        const slopeEps = 0.00005; // ~0.05 dB/1000km
        let aFavorsDX: boolean;
        if (Math.abs(regressionA.m - regressionB.m) > slopeEps) {
          aFavorsDX = regressionA.m > regressionB.m;
        } else if (dxA.length > 0 && dxB.length > 0 && localA.length > 0 && localB.length > 0) {
          aFavorsDX = dropA < dropB;
        } else {
          aFavorsDX = regressionA.m >= regressionB.m;
        }

        const [winnerLoss, loserLoss, winnerCall] = aFavorsDX
          ? [lossA, lossB, callA]
          : [lossB, lossA, callB];
        propagationNote = `[${winnerLoss} vs ${loserLoss} dB/1000km] Antenna ${winnerCall} favors DX (Low-angle)`;
      }
    }

    return { 
      spots: tableSpots, 
      deltaG, 
      timeSeriesData, 
      polarData, 
      mapLines: filteredSpots,
      countA: spotsA.length,
      countB: spotsB.length,
      scatterData: filteredSpots.map(s => {
        const target = viewMode === 'TX' ? s.transmitter : s.reporter;
        return {
          distance: s.distance || 0,
          snrA: target === callA ? s.snr_norm || 0 : null,
          snrB: target === callB ? s.snr_norm || 0 : null,
        };
      }),
      regressionA,
      regressionB,
      propagationNote,
      avgPowerA,
      avgPowerB,
      avgDelta,
      stdDevDelta,
      warnings
    };
  }, [baseData, timeSeriesData, callA, callB, brushRange, beamwidth, sortConfig, localThreshold, dxThreshold]);

  // --- Fetch Data ---
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/wspr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call1: callA, call2: callB, band, hours, viewMode }),
      });
      if (!response.ok) throw new Error('Failed to fetch WSPR data');
      const data = await response.json();
      if (data.data) {
        setRawData(data.data);
      } else {
        setRawData([]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // --- Export to CSV ---
  const exportToCSV = () => {
    if (!processed || processed.spots.length === 0) return;

    const headers = [
      'Time (UTC)',
      'TX',
      'Reporter',
      'Distance (km)',
      'SNR (dB)',
      'Power (dBm)',
      'SNR Normalized (dB)',
      'Is Match',
      'Delta (dB)',
      callB ? `Reference SNR (${callB})` : ''
    ].filter(Boolean).join(',');

    const rows = processed.spots.map(s => {
      let deltaStr = '';
      if (s.isMatch && s.snr_norm !== undefined && s.matchedSNRNorm !== undefined) {
        const isA = (viewMode === 'TX' ? s.transmitter : s.reporter) === callA;
        const delta = isA ? s.snr_norm - s.matchedSNRNorm : s.matchedSNRNorm - s.snr_norm;
        deltaStr = delta.toFixed(1);
      }

      return [
        format(parseISO(s.datetime), 'yyyy-MM-dd HH:mm:ss'),
        s.transmitter,
        s.reporter,
        s.distance?.toFixed(0) || '',
        s.snr,
        s.power,
        s.snr_norm?.toFixed(1) || '',
        s.isMatch ? 'Yes' : 'No',
        deltaStr,
        callB && s.matchedSNR !== undefined ? s.matchedSNR : ''
      ].filter((_, i) => i !== 9 || callB).join(',');
    });

    const csvContent = [headers, ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `wspr_spots_${callA}${callB ? `_vs_${callB}` : ''}_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex h-screen h-[100dvh] overflow-hidden bg-[#0a0a0a] text-zinc-300 relative">
      {/* Sidebar Overlay for mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/80 z-[3000] md:hidden backdrop-blur-md transition-opacity duration-300" 
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-[4000] w-[280px] sm:w-80 border-r border-white/10 bg-[#0f0f0f] flex flex-col transition-all duration-300 ease-in-out md:relative md:translate-x-0 h-full",
        isSidebarOpen ? "translate-x-0 shadow-[20px_0_50px_rgba(0,0,0,0.5)]" : "-translate-x-full md:-ml-80"
      )}>
        <div className="p-6 flex items-center justify-between border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-500/20 rounded-lg">
              <Radio className="w-6 h-6 text-orange-500" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">WSPR Lab</h1>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            className="p-3 -mr-2 text-zinc-500 hover:text-white transition-colors lg:hidden"
            aria-label="Close settings"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6 space-y-8 overscroll-contain">
          <div className="space-y-4">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
              <Settings className="w-3 h-3" /> Configuration
            </label>
            
            <div className="bg-zinc-900 border border-white/5 rounded-lg p-1 flex mb-4">
              <button
                onClick={() => setViewMode('TX')}
                className={cn(
                  "flex-1 text-xs font-bold py-2 rounded-md transition-all",
                  viewMode === 'TX' ? "bg-orange-600 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                TX Analysis
              </button>
              <button
                onClick={() => setViewMode('RX')}
                className={cn(
                  "flex-1 text-xs font-bold py-2 rounded-md transition-all",
                  viewMode === 'RX' ? "bg-orange-600 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                RX Analysis
              </button>
            </div>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block flex justify-between items-center">
                  Callsign A (Primary)
                  {viewMode === 'TX' && processed.avgPowerA !== null && (
                    <span className="text-[10px] font-mono text-orange-500 font-bold bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/20">
                      {processed.avgPowerA.toFixed(1)} dBm
                    </span>
                  )}
                </label>
                <input 
                  type="text" 
                  value={callA}
                  onChange={(e) => setCallA(e.target.value.toUpperCase())}
                  className="w-full bg-zinc-900 border border-white/5 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    Callsign B (Reference)
                    <span className="flex gap-2">
                      {nearbyError && <AlertCircle className="w-3 h-3 text-red-500" title="Failed to fetch nearby stations" />}
                      {loadingNearby && <RefreshCw className="w-3 h-3 animate-spin" />}
                    </span>
                  </div>
                  {viewMode === 'TX' && processed.avgPowerB !== null && (
                    <span className="text-[10px] font-mono text-cyan-500 font-bold bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                      {processed.avgPowerB.toFixed(1)} dBm
                    </span>
                  )}
                </label>
                <select 
                  value={callB}
                  onChange={(e) => setCallB(e.target.value)}
                  className={cn(
                    "w-full bg-zinc-900 border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500 transition-colors",
                    nearbyError ? "border-red-500/50" : "border-white/5"
                  )}
                >
                  <option value="">None</option>
                  {nearbyStations.map(s => (
                    <option key={s.tx_sign} value={s.tx_sign}>
                      {s.tx_sign} ({(s.distance / 1000).toFixed(0)} km, {s.power} dBm)
                    </option>
                  ))}
                  {callB && !nearbyStations.find(s => s.tx_sign === callB) && (
                    <option value={callB}>{callB} (Saved)</option>
                  )}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-xs text-zinc-400 mb-1 block">Frequency Band</label>
            <select 
              value={band}
              onChange={(e) => setBand(e.target.value)}
              className="w-full bg-zinc-900 border border-white/5 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
            >
              {BANDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </div>

          <div className="space-y-3">
            <label className="text-xs text-zinc-400 mb-1 block">Time Window</label>
            <select 
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="w-full bg-zinc-900 border border-white/5 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500"
            >
              {TIME_WINDOWS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <button 
            onClick={fetchData}
            disabled={loading}
            className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-md transition-all flex items-center justify-center gap-2 shadow-lg shadow-orange-900/20"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            Update Dashboard
          </button>

          {callB && (
            <div className="p-3 bg-zinc-900/30 rounded-xl border border-white/5 space-y-3">
              <label className="flex items-center justify-between cursor-pointer group">
                <div className="flex flex-col">
                  <span className="text-zinc-300 text-xs font-bold">Only Matches</span>
                  <span className="text-[9px] text-zinc-500 uppercase font-black tracking-widest mt-0.5">Strict Comparison</span>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input 
                    type="checkbox" 
                    className="sr-only peer" 
                    checked={showOnlyMatches}
                    onChange={(e) => setShowOnlyMatches(e.target.checked)}
                  />
                  <div className="w-8 h-4 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-zinc-500 after:border-zinc-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-orange-600 peer-checked:after:bg-white"></div>
                </div>
              </label>
            </div>
          )}

          <button 
            onClick={() => setIsHelpOpen(true)}
            className="w-full border border-white/10 hover:bg-white/5 text-zinc-400 hover:text-white text-xs font-semibold py-2 rounded-md transition-all flex items-center justify-center gap-2"
          >
            <Info className="w-4 h-4" />
            How it works (Guide)
          </button>
        </div>

        <div className="mt-auto pt-6 border-t border-white/5">
          <div className="flex items-start gap-3 p-3 bg-zinc-900/50 rounded-lg border border-white/5">
            <Info className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" />
            <p className="text-[10px] leading-relaxed text-zinc-500">
              Normalization: SNR_norm = snr - power. This removes transmitter power bias from antenna gain comparison.
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className={cn(
        "flex-1 overflow-y-auto custom-scrollbar flex flex-col overscroll-contain relative h-full",
        isSidebarOpen && "md:overflow-y-auto overflow-hidden pointer-events-none md:pointer-events-auto"
      )}>
        {/* Mobile Header */}
        <header className="sticky top-0 z-[2500] bg-[#0a0a0a]/90 backdrop-blur-md border-b border-white/5 p-4 flex items-center justify-between md:hidden">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-orange-500" />
            <h1 className="text-lg font-bold text-white">WSPR Lab</h1>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(true)}
            className="p-2 text-zinc-400 hover:text-white"
          >
            <Menu className="w-6 h-6" />
          </button>
        </header>

        {/* Desktop Toggle Button (when sidebar is closed) */}
        {!isSidebarOpen && (
          <button 
            onClick={() => setIsSidebarOpen(true)}
            className="hidden md:flex fixed top-6 left-6 z-[2000] p-3 bg-orange-600 hover:bg-orange-500 text-white rounded-xl shadow-xl shadow-orange-900/20 transition-all hover:scale-105"
            title="Open Configuration"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}

        <div className="p-4 md:p-8 flex-1">
          {error && (
            <div className="mb-8 p-4 bg-red-950/30 border border-red-900/50 rounded-lg flex items-center gap-3 text-red-400 text-sm">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          {/* Top Stats */}
          {viewMode === 'RX' && (
            <div className="mb-4 md:mb-6 p-4 bg-cyan-950/20 border border-cyan-900/30 rounded-lg flex items-start gap-3 text-cyan-500 text-sm">
              <Info className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <strong>Comparison mode:</strong> Assessing relative antenna sensitivity and local noise floor based on shared transmitters.
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
            <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Activity className="w-12 h-12" />
              </div>
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">Global &Delta;G</p>
              <div className="flex items-baseline gap-2">
                <h2 className={cn(
                  "text-4xl md:text-5xl font-black tracking-tighter",
                  processed.deltaG !== null ? (processed.deltaG >= 0 ? "text-green-500" : "text-red-500") : "text-zinc-700"
                )}>
                  {processed.deltaG !== null ? `${processed.deltaG > 0 ? '+' : ''}${processed.deltaG.toFixed(1)}` : '--.-'}
                </h2>
                <span className="text-xl font-bold text-zinc-600">dB</span>
              </div>
              <p className="text-[10px] text-zinc-500 mt-2 italic">
                {callB ? `All spots average difference` : 'Reference station required'}
              </p>
            </div>

            <div className="bg-[#151515] border border-orange-500/10 p-4 md:p-6 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <CheckCircle2 className="w-12 h-12 text-orange-500" />
              </div>
              <div className="flex items-center gap-1 group relative cursor-help">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-300 mb-2">Average System Advantage</p>
                <div className="absolute bottom-full left-0 mb-2 w-[240px] p-3 bg-zinc-900 border border-white/10 rounded-lg text-xs leading-relaxed text-zinc-300 shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 normal-case tracking-normal">
                  Mean delta for paired spots (matched identically by time and peer). Gives the true head-to-head advantage.
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <h2 className={cn(
                  "text-4xl md:text-5xl font-black tracking-tighter",
                  processed.avgDelta !== null ? (processed.avgDelta >= 0 ? "text-green-500" : "text-red-500") : "text-zinc-700"
                )}>
                  {processed.avgDelta !== null ? `${processed.avgDelta > 0 ? '+' : ''}${processed.avgDelta.toFixed(1)}` : '--.-'}
                </h2>
                <span className="text-xl font-bold text-zinc-600">dB</span>
              </div>
              <p className={cn(
                  "text-[10px] mt-2 font-bold",
                  processed.stdDevDelta !== null && processed.stdDevDelta > 5 ? "text-orange-400" : "text-zinc-500"
                )}>
                {processed.stdDevDelta !== null ? (
                  processed.stdDevDelta > 5 ? "High variance due to distance/propagation." : `Confidence interval ±${processed.stdDevDelta.toFixed(1)}dB`
                ) : 'Requires matches'}
              </p>
            </div>

            <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">Total Spots</p>
              <h2 className="text-4xl md:text-5xl font-black tracking-tighter text-white">
                {processed.spots.length}
              </h2>
              <div className="flex gap-4 mt-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-orange-500" />
                  <span className="text-[10px] font-bold text-zinc-400">{callA}: {processed.countA}</span>
                </div>
                {callB && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-[10px] font-bold text-zinc-400">{callB}: {processed.countB}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl">
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">
                {viewMode === 'TX' ? 'Active Reporters' : 'Active Transmitters'}
              </p>
              <h2 className="text-4xl md:text-5xl font-black tracking-tighter text-white">
                {new Set(processed.spots.map(s => viewMode === 'TX' ? s.reporter : s.transmitter)).size}
              </h2>
              <p className="text-[10px] text-zinc-500 mt-2">
                {viewMode === 'TX' ? 'Unique receiving stations' : 'Unique transmitting stations'}
              </p>
            </div>
          </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8 mb-8">
          {/* SNR vs Time */}
          <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[400px] md:h-[450px]">
            <div className="flex items-center justify-between mb-4 md:mb-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-orange-500" /> {viewMode === 'TX' ? 'SNR Normalized vs Time' : 'Receive Efficiency (dB)'}
              </h3>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={processed.timeSeriesData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis 
                    dataKey="time" 
                    stroke="#525252" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                  />
                  <YAxis 
                    stroke="#525252" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    label={{ value: 'dB', angle: -90, position: 'insideLeft', fill: '#525252', fontSize: 10 }}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#151515', border: '1px solid #262626', borderRadius: '8px', fontSize: '12px' }}
                    itemStyle={{ padding: '0' }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                  <Line 
                    type="monotone" 
                    dataKey={callA} 
                    stroke="#f97316" 
                    strokeWidth={3} 
                    dot={false} 
                    activeDot={{ r: 6, stroke: '#000', strokeWidth: 2 }}
                  />
                  {callB && (
                    <Line 
                      type="monotone" 
                      dataKey={callB} 
                      stroke="#06b6d4" 
                      strokeWidth={3} 
                      dot={false} 
                      activeDot={{ r: 6, stroke: '#000', strokeWidth: 2 }}
                    />
                  )}
                  <Brush 
                    data={processed.timeSeriesData}
                    dataKey="time" 
                    height={30} 
                    stroke="#f97316" 
                    fill="#151515"
                    travellerWidth={10}
                    startIndex={brushRange.startIndex}
                    endIndex={brushRange.endIndex}
                    onChange={(range) => setBrushRange(range)}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Polar Pattern */}
          <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[400px] md:h-[450px]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 md:mb-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Compass className="w-4 h-4 text-orange-500" /> {viewMode === 'TX' ? 'Observed Signal Coverage' : 'Observed Reception Pattern'}
                <div className="relative group flex items-center ml-1">
                  <Info className="w-4 h-4 text-zinc-500 group-hover:text-cyan-500 cursor-help transition-colors" />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[280px] sm:w-[320px] p-3 bg-zinc-900 border border-white/10 rounded-lg text-xs leading-relaxed text-zinc-300 shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 normal-case tracking-normal">
                    {viewMode === 'TX' 
                      ? "This chart visualizes where your signal was actually decoded. Please note: The shape is defined by both your antenna's performance and the current global distribution of active WSPR receivers. A 'null' in a certain direction may indicate a lack of available reporters rather than a flaw in the antenna."
                      : "This chart visualizes where you are receiving signals from. The shape is defined by both your antenna's performance and the current active WSPR transmitters."}
                  </div>
                </div>
              </h3>
              
              <div className="flex items-center gap-4 bg-zinc-900/50 p-2 rounded-lg border border-white/5">
                <div className="flex flex-col">
                  <span className="text-[10px] text-zinc-500 uppercase font-bold leading-none mb-1">Beamwidth</span>
                  <span className="text-xs font-mono text-orange-500 leading-none">{beamwidth}°</span>
                </div>
                <input 
                  type="range" 
                  min="10" 
                  max="90" 
                  step="5"
                  value={beamwidth}
                  onChange={(e) => setBeamwidth(Number(e.target.value))}
                  className="w-24 md:w-32 accent-orange-600 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart cx="50%" cy="50%" outerRadius="80%" data={processed.polarData}>
                  <PolarGrid stroke="#262626" />
                  <PolarAngleAxis 
                    dataKey="azimuth" 
                    stroke="#525252" 
                    fontSize={10} 
                    tickFormatter={(v) => (v % 10 === 0 ? `${v}°` : '')} 
                  />
                  <PolarRadiusAxis 
                    angle={90} 
                    domain={[-40, 0]} 
                    stroke="#525252" 
                    fontSize={8} 
                    tickFormatter={(v) => `${v} dB`}
                    axisLine={false}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#151515', border: '1px solid #262626', borderRadius: '8px', fontSize: '12px' }}
                    formatter={(value: number) => [`${value} dB relative`, 'Gain']}
                  />
                  <Radar
                    name={callA}
                    dataKey={callA}
                    stroke="#f97316"
                    fill="#f97316"
                    fillOpacity={0.4}
                    dot={false}
                  />
                  {callB && (
                    <Radar
                      name={callB}
                      dataKey={callB}
                      stroke="#06b6d4"
                      fill="#06b6d4"
                      fillOpacity={0.4}
                      dot={false}
                    />
                  )}
                  {/* Data Density Markers */}
                  <Radar
                    name="Data Source A"
                    dataKey="markerA"
                    stroke="none"
                    fill="none"
                    dot={{ r: 2, fill: '#f97316', stroke: '#000', strokeWidth: 1 }}
                    legendType="none"
                  />
                  {callB && (
                    <Radar
                      name="Data Source B"
                      dataKey="markerB"
                      stroke="none"
                      fill="none"
                      dot={{ r: 2, fill: '#06b6d4', stroke: '#000', strokeWidth: 1 }}
                      legendType="none"
                    />
                  )}
                  <Legend wrapperStyle={{ fontSize: '10px' }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Distance-SNR Correlation */}
          <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[500px] md:h-[550px] lg:col-span-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 md:mb-6">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                  <Activity className="w-4 h-4 text-orange-500" /> Distance-SNR Correlation (Low-Angle Analysis)
                </h3>
                <div className="flex flex-wrap gap-2">
                  {processed.propagationNote && (
                    <p className="text-[10px] text-orange-500 font-bold uppercase tracking-widest px-2 py-1 bg-orange-500/10 rounded border border-orange-500/20 w-fit">
                      {processed.propagationNote}
                    </p>
                  )}
                  {(processed.warnings.lowDataDx || processed.warnings.lowDataLocal) && (
                    <p className="text-[10px] text-yellow-500 font-bold uppercase tracking-widest px-2 py-1 bg-yellow-500/10 rounded border border-yellow-500/20 w-fit">
                      ⚠️ Insufficient data for selected thresholds
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-4 bg-zinc-900/50 p-2 rounded-lg border border-white/5">
                  <div className="flex flex-col min-w-[80px]">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold leading-none mb-1">Local Thr.</span>
                    <span className="text-xs font-mono text-orange-500 leading-none">{localThreshold} km</span>
                  </div>
                  <input 
                    type="range" 
                    min="500" 
                    max="3000" 
                    step="100"
                    value={localThreshold}
                    onChange={(e) => setLocalThreshold(Number(e.target.value))}
                    className="w-24 md:w-32 accent-orange-600 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
                <div className="flex items-center gap-4 bg-zinc-900/50 p-2 rounded-lg border border-white/5">
                  <div className="flex flex-col min-w-[80px]">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold leading-none mb-1">DX Thr.</span>
                    <span className="text-xs font-mono text-orange-500 leading-none">{dxThreshold} km</span>
                  </div>
                  <input 
                    type="range" 
                    min="3000" 
                    max="10000" 
                    step="100"
                    value={dxThreshold}
                    onChange={(e) => setDxThreshold(Number(e.target.value))}
                    className="w-24 md:w-32 accent-orange-600 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart margin={{ top: 10, right: 30, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <ReferenceLine x={localThreshold} stroke="#525252" strokeDasharray="3 3" label={{ value: 'Local', position: 'insideTopLeft', fill: '#525252', fontSize: 10 }} />
                  <ReferenceLine x={dxThreshold} stroke="#525252" strokeDasharray="3 3" label={{ value: 'DX', position: 'insideTopLeft', fill: '#525252', fontSize: 10 }} />
                  <XAxis 
                    type="number" 
                    dataKey="distance" 
                    name="Distance" 
                    unit=" km" 
                    stroke="#525252" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    domain={[0, 'auto']}
                    tickFormatter={(val) => Math.round(val).toString()}
                  />
                  <YAxis 
                    type="number" 
                    stroke="#525252" 
                    fontSize={10} 
                    tickLine={false} 
                    axisLine={false}
                    domain={[-40, 20]}
                    tickFormatter={(val) => Math.round(val).toString()}
                    label={{ value: 'Norm. SNR (dB)', angle: -90, position: 'insideLeft', fill: '#525252', fontSize: 10, offset: 10 }}
                  />
                  <ZAxis type="number" range={[64, 64]} />
                  <Tooltip 
                    cursor={{ strokeDasharray: '3 3' }} 
                    contentStyle={{ backgroundColor: '#151515', border: '1px solid #262626', borderRadius: '8px', fontSize: '12px' }}
                    formatter={(value: number, name: string) => [`${Math.round(value)} dB`, name]}
                    labelFormatter={(label: number) => `${Math.round(label)} km`}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                  
                  <Scatter 
                    name={callA} 
                    dataKey="snr"
                    data={processed.scatterData.filter(d => d.snrA !== null).map(d => ({ distance: d.distance, snr: d.snrA }))} 
                    fill="#f97316" 
                    strokeWidth={1}
                    stroke="#f97316"
                    opacity={0.6} 
                  />
                  {callB && (
                    <Scatter 
                      name={callB} 
                      dataKey="snr"
                      data={processed.scatterData.filter(d => d.snrB !== null).map(d => ({ distance: d.distance, snr: d.snrB }))} 
                      fill="#06b6d4" 
                      strokeWidth={1}
                      stroke="#06b6d4"
                      opacity={0.6} 
                    />
                  )}
                  
                  {processed.regressionA && (
                    <Line
                      name={`${callA} Trend`}
                      data={[
                        { distance: 0, snr: processed.regressionA.b },
                        { distance: 20000, snr: processed.regressionA.m * 20000 + processed.regressionA.b }
                      ]}
                      dataKey="snr"
                      stroke="#f97316"
                      strokeWidth={2}
                      dot={false}
                      strokeDasharray="5 5"
                      legendType="none"
                    />
                  )}
                  {callB && processed.regressionB && (
                    <Line
                      name={`${callB} Trend`}
                      data={[
                        { distance: 0, snr: processed.regressionB.b },
                        { distance: 20000, snr: processed.regressionB.m * 20000 + processed.regressionB.b }
                      ]}
                      dataKey="snr"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      dot={false}
                      strokeDasharray="5 5"
                      legendType="none"
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[400px] md:h-[500px] mb-8">
          <div className="flex items-center justify-between mb-4 md:mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
              <MapIcon className="w-4 h-4 text-orange-500" /> Signal Propagation Map
            </h3>
          </div>
          <div className="flex-1 rounded-lg overflow-hidden border border-white/5">
            <MapContainer 
              center={[40, 0]} 
              zoom={2} 
              style={{ height: '100%', width: '100%' }}
              scrollWheelZoom={true}
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              />
              {processed.spots.slice(0, 500).map((s, idx) => {
                const target = viewMode === 'TX' ? s.transmitter : s.reporter;
                const isA = target === callA;
                const centerLat = viewMode === 'TX' ? s.rx_lat : s.tx_lat;
                const centerLon = viewMode === 'TX' ? s.rx_lon : s.tx_lon;
                return (
                <React.Fragment key={idx}>
                  <Polyline 
                    positions={getGreatCirclePath(s.tx_lat, s.tx_lon, s.rx_lat, s.rx_lon)}
                    pathOptions={{ 
                      color: isA ? '#f97316' : '#06b6d4', 
                      weight: Math.max(1, (s.snr_norm || 0) / 10 + 2),
                      opacity: s.isMatch ? 0.6 : 0.2
                    }}
                  >
                    <Popup>
                      <div className="text-xs">
                        <strong>From:</strong> {s.transmitter}<br/>
                        <strong>To:</strong> {s.reporter}<br/>
                        <strong>Distance:</strong> {s.distance?.toFixed(0)} km<br/>
                        <strong>SNR:</strong> {s.snr} dB<br/>
                        <strong>SNR Norm:</strong> {s.snr_norm?.toFixed(1)} dB
                      </div>
                    </Popup>
                  </Polyline>
                  <CircleMarker 
                    center={[centerLat, centerLon]} 
                    radius={s.isMatch ? 4 : 2}
                    pathOptions={{ 
                      fillColor: isA ? '#f97316' : '#06b6d4', 
                      fillOpacity: 0.8,
                      stroke: s.isMatch,
                      color: '#fff',
                      weight: 1
                    }}
                  >
                    <Popup>
                      <div className="text-xs">
                        <strong>{viewMode === 'TX' ? 'Reporter' : 'Transmitter'}:</strong> {viewMode === 'TX' ? s.reporter : s.transmitter}<br/>
                        <strong>Distance:</strong> {s.distance?.toFixed(0)} km<br/>
                        <strong>SNR Norm:</strong> {s.snr_norm?.toFixed(1)} dB<br/>
                        <strong>Azimuth:</strong> {s.azimuth?.toFixed(0)}°
                        {s.isMatch && <div className="mt-1 text-green-500 font-bold">MATCH FOUND</div>}
                      </div>
                    </Popup>
                  </CircleMarker>
                </React.Fragment>
              )})}
            </MapContainer>
          </div>
        </div>

        {/* Spots Table */}
        <div className="bg-[#151515] border border-white/5 rounded-xl overflow-hidden mb-8">
          <div className="p-4 border-b border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <TableIcon className="w-4 h-4 text-orange-500" /> Recent Spots & Comparisons
              </h3>
            </div>
            
            <div className="flex items-center gap-4">
              <div className="flex gap-4 text-[10px] uppercase tracking-wider font-semibold">
                <span className="flex items-center gap-1 text-orange-500">
                  <div className="w-2 h-2 rounded-full bg-orange-500" /> {callA}
                </span>
                {callB && (
                  <span className="flex items-center gap-1 text-blue-500">
                    <div className="w-2 h-2 rounded-full bg-blue-500" /> {callB}
                  </span>
                )}
              </div>
              <button
                onClick={exportToCSV}
                className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-md text-xs font-semibold transition-colors border border-white/5"
                title="Export to CSV"
              >
                <Download className="w-3.5 h-3.5" />
                Export
              </button>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-left text-[10px] md:text-xs border-collapse">
              <thead className="sticky top-0 bg-[#151515] z-10">
                <tr className="text-zinc-500 border-b border-white/5">
                  <th 
                    className="p-2 md:p-4 font-bold uppercase tracking-widest cursor-pointer hover:text-white transition-colors"
                    onClick={() => setSortConfig({ key: 'datetime', direction: sortConfig.key === 'datetime' && sortConfig.direction === 'desc' ? 'asc' : 'desc' })}
                  >
                    <div className="flex items-center gap-1">
                      Time {sortConfig.key === 'datetime' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </div>
                  </th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest">TX</th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest">Reporter</th>
                  <th 
                    className="p-2 md:p-4 font-bold uppercase tracking-widest text-right cursor-pointer hover:text-white transition-colors"
                    onClick={() => setSortConfig({ key: 'distance', direction: sortConfig.key === 'distance' && sortConfig.direction === 'desc' ? 'asc' : 'desc' })}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Dist {sortConfig.key === 'distance' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </div>
                  </th>
                  <th 
                    className="p-2 md:p-4 font-bold uppercase tracking-widest text-right cursor-pointer hover:text-white transition-colors"
                    onClick={() => setSortConfig({ key: 'snr', direction: sortConfig.key === 'snr' && sortConfig.direction === 'desc' ? 'asc' : 'desc' })}
                  >
                    <div className="flex items-center justify-end gap-1">
                      SNR {sortConfig.key === 'snr' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </div>
                  </th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest text-right">Pwr</th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest text-right">Norm</th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest text-center">Match</th>
                  <th className="p-2 md:p-4 font-bold uppercase tracking-widest text-right group relative">
                    <div className="flex items-center justify-end gap-1 cursor-help">
                      Delta
                      <div className="absolute bottom-full right-0 mb-2 w-[240px] p-3 bg-zinc-900 border border-white/10 rounded-lg text-xs leading-relaxed text-zinc-300 shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 normal-case tracking-normal">
                        Calculated as (A - B) for spots received/transmitted at the same time. Positive value means Station A performed better.
                      </div>
                    </div>
                  </th>
                  {callB && <th className="p-2 md:p-4 font-bold uppercase tracking-widest text-right">Ref</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {processed.spots.slice(0, 200).map((s, i) => (
                  <tr key={i} className={cn(
                    "hover:bg-white/5 transition-colors",
                    s.isMatch && "bg-orange-500/5"
                  )}>
                    <td className="p-2 md:p-4 text-zinc-400">{format(parseISO(s.datetime), 'HH:mm')}</td>
                    <td className={cn(
                      "p-2 md:p-4 font-mono",
                      viewMode === 'TX' 
                        ? (s.transmitter === callA ? "font-bold text-orange-500" : "font-bold text-blue-500")
                        : "text-zinc-300"
                    )}>{s.transmitter}</td>
                    <td className={cn(
                      "p-2 md:p-4 font-mono",
                      viewMode === 'RX'
                        ? (s.reporter === callA ? "font-bold text-orange-500" : "font-bold text-blue-500")
                        : "text-zinc-300"
                    )}>{s.reporter}</td>
                    <td className="p-2 md:p-4 text-right font-mono text-zinc-400">{s.distance?.toFixed(0)}</td>
                    <td className="p-2 md:p-4 text-right font-mono text-white">{s.snr}</td>
                    <td className="p-2 md:p-4 text-right font-mono text-zinc-500">{s.power}</td>
                    <td className="p-2 md:p-4 text-right font-mono text-zinc-400">{s.snr_norm?.toFixed(1)}</td>
                    <td className="p-2 md:p-4 text-center">
                      {s.isMatch && (
                        <div className="inline-flex items-center justify-center">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                        </div>
                      )}
                    </td>
                    <td className="p-2 md:p-4 text-right font-mono">
                      {s.isMatch && s.snr_norm !== undefined && s.matchedSNRNorm !== undefined ? (() => {
                        const isA = (viewMode === 'TX' ? s.transmitter : s.reporter) === callA;
                        const delta = isA ? s.snr_norm - s.matchedSNRNorm : s.matchedSNRNorm - s.snr_norm;
                        return (
                          <span className={cn(
                            delta > 0 ? "text-green-500 font-bold" : (delta < 0 ? "text-orange-500 font-bold" : "text-zinc-400")
                          )}>
                            {delta > 0 ? '+' : ''}{delta.toFixed(1)} dB
                          </span>
                        );
                      })() : <span className="text-zinc-600">-</span>}
                    </td>
                    {callB && (
                      <td className="p-2 md:p-4 text-right font-mono text-zinc-500">
                        {s.matchedSNR !== undefined ? (
                          <span className={cn(
                            s.snr > s.matchedSNR ? "text-green-500/70" : "text-red-500/70"
                          )}>
                            {s.matchedSNR}
                          </span>
                        ) : '-'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>

    {/* Help Modal */}
    {isHelpOpen && (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
        <div 
          className="absolute inset-0 bg-black/80 backdrop-blur-sm" 
          onClick={() => setIsHelpOpen(false)}
        />
        <div className="relative bg-[#151515] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] max-h-[90dvh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b border-white/5 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-orange-500" />
              <div>
                <h2 className="text-xl font-bold text-white">WSPR Antenna Lab Guide</h2>
                <p className="text-[10px] text-zinc-500 font-bold tracking-widest uppercase">Version {APP_VERSION}</p>
              </div>
            </div>
            <button 
              onClick={() => setIsHelpOpen(false)}
              className="p-2 text-zinc-500 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          
          <div className="p-8 overflow-y-auto custom-scrollbar space-y-8 text-sm leading-relaxed text-zinc-400">
            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Overview</h3>
              <p>
                WSPR Antenna Lab is a specialized tool for radio amateurs to compare the real-world performance of two antennas. 
                By leveraging global WSPR data, it provides objective metrics on gain, signal coverage, and propagation efficiency.
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Analysis Modes</h3>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">TX</div>
                  <p><strong className="text-zinc-200">TX Analysis:</strong> Evaluates your transmit antenna by analyzing spots from global receivers that decoded your signal.</p>
                </div>
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-500 flex items-center justify-center shrink-0 font-bold text-xs">RX</div>
                  <p><strong className="text-zinc-200">RX Analysis:</strong> Assesses your receiving antenna's sensitivity and local noise floor based on distant transmitters you hear.</p>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Analysis Workflow</h3>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">1</div>
                  <p><strong className="text-zinc-200">Callsign A (Primary):</strong> The antenna you want to evaluate.</p>
                </div>
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">2</div>
                  <p><strong className="text-zinc-200">Callsign B (Reference):</strong> A nearby station used as a baseline. Ideally within 50km and using a standard antenna (e.g., dipole) for a fair comparison.</p>
                </div>
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">3</div>
                  <p><strong className="text-zinc-200">Only Matches:</strong> Analyzes only paired spots where both A and B share the same peer in the same time slot. In <strong>TX mode</strong>, this means both were heard by the same reporter. In <strong>RX mode</strong>, both heard the same transmitter. This gives the truest head-to-head comparison.</p>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Core Analytics</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Delta Analysis</h4>
                  <p className="text-xs">
                    Uses matched spots to calculate the <strong>Average System Advantage</strong> and lists individual spot <strong>Delta</strong> values in the table, giving precision to your head-to-head comparisons.
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Live Signal Reach & Reception</h4>
                  <p className="text-xs">
                    Visualizes gain per azimuth in 10° bins. Use the <strong className="text-zinc-300">Beamwidth</strong> slider to adjust the smoothing sensitivity (averaging range) for each direction.
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Low-Angle Analysis</h4>
                  <p className="text-xs">
                    Uses linear regression (Trendlines) on the SNR vs. Distance chart. A flatter trendline indicates better performance at low radiation angles, favoring long-distance (DX).
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Custom Thresholds</h4>
                  <p className="text-xs">
                    Set your own <strong className="text-zinc-300">Local</strong> and <strong className="text-zinc-300">DX</strong> boundaries. The app calculates SNR drops between these zones to detect "DX Advantage".
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">SNR Normalization</h4>
                  <p className="text-xs">
                    In TX mode: <code className="text-orange-500">SNR - TX Power</code>. In RX mode: <code className="text-cyan-500">SNR - RX Power</code>. This prevents power differences from skewing the results.
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Data Export</h4>
                  <p className="text-xs">
                    Click the <strong>Export</strong> button above the spots table to download the current view's data as a CSV file, including calculated <strong className="text-orange-500">Delta</strong> values.
                  </p>
                </div>
              </div>
            </section>

            <section className="space-y-4 pt-4 border-t border-white/5">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Feedback & Support</h3>
              <p>
                Feedback is welcome! If you have any questions or suggestions, feel free to reach out.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <a 
                  href="mailto:ondra@ok1cdj.com" 
                  className="flex items-center gap-2 text-zinc-200 hover:text-orange-500 transition-colors"
                >
                  <Mail className="w-4 h-4" />
                  ondra@ok1cdj.com
                </a>
                <a 
                  href="https://buymeacoffee.com/ok1cdj" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-zinc-200 hover:text-orange-500 transition-colors"
                >
                  <Coffee className="w-4 h-4" />
                  Buy Me a Coffee
                </a>
              </div>
            </section>
          </div>

          <div className="p-6 border-t border-white/5 bg-zinc-900/30">
            <button 
              onClick={() => setIsHelpOpen(false)}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-3 rounded-xl transition-all"
            >
              Got it, thanks!
            </button>
          </div>
        </div>
      </div>
    )}
    <Analytics />
    </div>
  );
}
