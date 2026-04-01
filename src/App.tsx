/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Brush
} from 'recharts';
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup } from 'react-leaflet';
import { format, parseISO, startOfMinute } from 'date-fns';
import { 
  Settings, Activity, Map as MapIcon, Radio, 
  ChevronRight, RefreshCw, AlertCircle, Info,
  Compass, Table as TableIcon, CheckCircle2,
  Menu, X, Mail, Coffee
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

// --- Constants ---
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
  }, [callA, callB, band, hours, beamwidth]);

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
        body: JSON.stringify({ callA, band }),
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
  }, [callA, band]);

  // --- Data Processing ---
  const allSpots = useMemo((): WSPRSpot[] => {
    if (!rawData || rawData.length === 0) return [];
    return rawData.map(d => ({
      ...d,
      snr_norm: d.snr - d.power,
      distance: getDistance(d.tx_lat, d.tx_lon, d.rx_lat, d.rx_lon)
    }));
  }, [rawData]);

  const timeSeriesData = useMemo(() => {
    if (allSpots.length === 0) return [];
    const timeGroups: Record<string, { time: string, snrA: number[], snrB: number[] }> = {};
    allSpots.forEach(s => {
      const date = parseISO(s.datetime);
      const slot = format(new Date(Math.floor(date.getTime() / (10 * 60 * 1000)) * (10 * 60 * 1000)), 'HH:mm');
      if (!timeGroups[slot]) timeGroups[slot] = { time: slot, snrA: [], snrB: [] };
      if (s.transmitter === callA) timeGroups[slot].snrA.push(s.snr_norm || 0);
      else if (s.transmitter === callB) timeGroups[slot].snrB.push(s.snr_norm || 0);
    });

    return Object.values(timeGroups)
      .map(g => ({
        time: g.time,
        [callA]: g.snrA.length > 0 ? Number((g.snrA.reduce((a, b) => a + b, 0) / g.snrA.length).toFixed(1)) : null,
        [callB]: g.snrB.length > 0 ? Number((g.snrB.reduce((a, b) => a + b, 0) / g.snrB.length).toFixed(1)) : null,
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [allSpots, callA, callB]);

  const processed = useMemo((): ProcessedData => {
    if (allSpots.length === 0) {
      return { spots: [], deltaG: null, timeSeriesData: [], polarData: [], mapLines: [], countA: 0, countB: 0 };
    }

    // 1. Filter spots based on Brush selection
    let filteredSpots = allSpots;
    if (brushRange.startIndex !== undefined && brushRange.endIndex !== undefined && timeSeriesData.length > 0) {
      const startTime = timeSeriesData[brushRange.startIndex]?.time;
      const endTime = timeSeriesData[brushRange.endIndex]?.time;
      
      if (startTime && endTime) {
        filteredSpots = allSpots.filter(s => {
          const t = format(parseISO(s.datetime), 'HH:mm');
          return t >= startTime && t <= endTime;
        });
      }
    }

    // 2. Calculate Stats based on filtered spots
    const spotsA = filteredSpots.filter(s => s.transmitter === callA);
    const spotsB = callB ? filteredSpots.filter(s => s.transmitter === callB) : [];

    const avgA = spotsA.length > 0 ? spotsA.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / spotsA.length : null;
    const avgB = spotsB.length > 0 ? spotsB.reduce((acc, s) => acc + (s.snr_norm || 0), 0) / spotsB.length : null;
    
    const deltaG = (avgA !== null && avgB !== null) ? avgA - avgB : null;

    // 3. Polar Data (Normalized to 0 dB relative max with Gaussian Smoothing)
    const azimuthBins: Record<number, { azimuth: number, snrA: number[], snrB: number[] }> = {};
    for (let i = 0; i < 360; i += 10) azimuthBins[i] = { azimuth: i, snrA: [], snrB: [] };

    filteredSpots.forEach(s => {
      const bin = Math.floor(s.azimuth / 10) * 10;
      if (azimuthBins[bin]) {
        if (s.transmitter === callA) azimuthBins[bin].snrA.push(s.snr_norm || 0);
        else if (s.transmitter === callB) azimuthBins[bin].snrB.push(s.snr_norm || 0);
      }
    });

    const rawAverages = Object.values(azimuthBins).map(b => ({
      azimuth: b.azimuth,
      avgA: b.snrA.length > 0 ? b.snrA.reduce((a, b) => a + b, 0) / b.snrA.length : null,
      avgB: b.snrB.length > 0 ? b.snrB.reduce((a, b) => a + b, 0) / b.snrB.length : null,
      countA: b.snrA.length,
      countB: b.snrB.length
    }));

    // Find global max for normalization (Outlier Protection: average of top 5%)
    const allVals = rawAverages.flatMap(d => [d.avgA, d.avgB]).filter((v): v is number => v !== null);
    let globalMax = 0;
    if (allVals.length > 0) {
      const sorted = [...allVals].sort((a, b) => b - a);
      const topCount = Math.max(1, Math.ceil(sorted.length * 0.05));
      const topVals = sorted.slice(0, topCount);
      globalMax = topVals.reduce((a, b) => a + b, 0) / topCount;
    }

    // Gaussian Smoothing Function
    const sigma = beamwidth / 2.355;
    const smooth = (targetAz: number, data: { azimuth: number, val: number | null }[]) => {
      // Noise Floor Anchor: Start with a small constant weight at -40dB.
      // This ensures that if data is far away (Gaussian weight < 0.01), 
      // the value pulls back to the center (-40dB) instead of staying flat.
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
        // Markers for significant data points (at the edge)
        markerA: rawBin && rawBin.countA > 3 ? 0.5 : null,
        markerB: rawBin && rawBin.countB > 3 ? 0.5 : null,
      });
    }

    // 4. Identify Matching Spots
    const spotsByTimeAndReporter: Record<string, Record<string, WSPRSpot>> = {};
    const spotsWithMatchInfo = filteredSpots.map(s => ({
      ...s,
      isMatch: false,
      matchedSNR: undefined
    }));

    spotsWithMatchInfo.forEach(s => {
      const key = `${s.datetime}_${s.reporter}`;
      if (!spotsByTimeAndReporter[key]) spotsByTimeAndReporter[key] = {};
      spotsByTimeAndReporter[key][s.transmitter] = s;
    });

    spotsWithMatchInfo.forEach(s => {
      const key = `${s.datetime}_${s.reporter}`;
      const otherCall = s.transmitter === callA ? callB : callA;
      if (otherCall && spotsByTimeAndReporter[key][otherCall]) {
        s.isMatch = true;
        s.matchedSNR = spotsByTimeAndReporter[key][otherCall].snr;
      }
    });

    // 5. Apply Table Filter (Only Matches)
    let tableSpots = spotsWithMatchInfo;
    if (showOnlyMatches) {
      tableSpots = tableSpots.filter(s => s.isMatch);
    }

    // 6. Apply Table Sorting
    tableSpots = [...tableSpots].sort((a, b) => {
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

    return { 
      spots: tableSpots, 
      deltaG, 
      timeSeriesData, 
      polarData, 
      mapLines: spotsWithMatchInfo,
      countA: spotsA.length,
      countB: spotsB.length
    };
  }, [allSpots, timeSeriesData, callA, callB, brushRange, beamwidth, showOnlyMatches, sortConfig]);

  // --- Fetch Data ---
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/wspr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call1: callA, call2: callB, band, hours }),
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

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0a0a] text-zinc-300 relative">
      {/* Sidebar Overlay for mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-40 md:hidden backdrop-blur-sm transition-opacity duration-300" 
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-80 border-r border-white/10 bg-[#0f0f0f] p-6 flex flex-col gap-8 transition-all duration-300 ease-in-out md:relative md:translate-x-0",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full md:-ml-80"
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-500/20 rounded-lg">
              <Radio className="w-6 h-6 text-orange-500" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">WSPR Lab</h1>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            className="p-2 text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto custom-scrollbar pr-2">
          <div className="space-y-4">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
              <Settings className="w-3 h-3" /> Configuration
            </label>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Callsign A (Primary)</label>
                <input 
                  type="text" 
                  value={callA}
                  onChange={(e) => setCallA(e.target.value.toUpperCase())}
                  className="w-full bg-zinc-900 border border-white/5 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block flex justify-between">
                  Callsign B (Reference)
                  <span className="flex gap-2">
                    {nearbyError && <AlertCircle className="w-3 h-3 text-red-500" title="Failed to fetch nearby stations" />}
                    {loadingNearby && <RefreshCw className="w-3 h-3 animate-spin" />}
                  </span>
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
      <main className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">
        {/* Mobile Header */}
        <header className="sticky top-0 z-30 bg-[#0a0a0a]/80 backdrop-blur-md border-b border-white/5 p-4 flex items-center justify-between md:hidden">
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
            className="hidden md:flex fixed top-6 left-6 z-40 p-3 bg-orange-600 hover:bg-orange-500 text-white rounded-xl shadow-xl shadow-orange-900/20 transition-all hover:scale-105"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 md:gap-6 mb-8">
            <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <Activity className="w-12 h-12" />
              </div>
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">Antenna Delta ($\Delta G$)</p>
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
                {callB ? `Relative gain of ${callA} vs ${callB}` : 'Reference station required'}
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

            <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl sm:col-span-2 md:col-span-1">
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">Active Reporters</p>
              <h2 className="text-4xl md:text-5xl font-black tracking-tighter text-white">
                {new Set(processed.spots.map(s => s.reporter)).size}
              </h2>
              <p className="text-[10px] text-zinc-500 mt-2">
                Unique receiving stations
              </p>
            </div>
          </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8 mb-8">
          {/* SNR vs Time */}
          <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[350px] md:h-[400px]">
            <div className="flex items-center justify-between mb-4 md:mb-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-orange-500" /> SNR Normalized vs Time
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

          {/* Polar Radiation Pattern */}
          <div className="bg-[#151515] border border-white/5 p-4 md:p-6 rounded-xl flex flex-col h-[400px] md:h-[450px]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 md:mb-6">
              <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                <Compass className="w-4 h-4 text-orange-500" /> Radiation Pattern
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
              {processed.spots.slice(0, 500).map((s, idx) => (
                <React.Fragment key={idx}>
                  <Polyline 
                    positions={getGreatCirclePath(s.tx_lat, s.tx_lon, s.rx_lat, s.rx_lon)}
                    pathOptions={{ 
                      color: s.transmitter === callA ? '#f97316' : '#06b6d4', 
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
                    center={[s.rx_lat, s.rx_lon]} 
                    radius={s.isMatch ? 4 : 2}
                    pathOptions={{ 
                      fillColor: s.transmitter === callA ? '#f97316' : '#06b6d4', 
                      fillOpacity: 0.8,
                      stroke: s.isMatch,
                      color: '#fff',
                      weight: 1
                    }}
                  >
                    <Popup>
                      <div className="text-xs">
                        <strong>Reporter:</strong> {s.reporter}<br/>
                        <strong>Distance:</strong> {s.distance?.toFixed(0)} km<br/>
                        <strong>SNR Norm:</strong> {s.snr_norm?.toFixed(1)} dB<br/>
                        <strong>Azimuth:</strong> {s.azimuth}°
                        {s.isMatch && <div className="mt-1 text-green-500 font-bold">MATCH FOUND</div>}
                      </div>
                    </Popup>
                  </CircleMarker>
                </React.Fragment>
              ))}
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
              
              {callB && (
                <label className="flex items-center gap-2 cursor-pointer group">
                  <div className="relative">
                    <input 
                      type="checkbox" 
                      className="sr-only" 
                      checked={showOnlyMatches}
                      onChange={() => setShowOnlyMatches(!showOnlyMatches)}
                    />
                    <div className={cn(
                      "w-8 h-4 rounded-full transition-colors",
                      showOnlyMatches ? "bg-orange-600" : "bg-zinc-800"
                    )} />
                    <div className={cn(
                      "absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform",
                      showOnlyMatches ? "translate-x-4" : "translate-x-0"
                    )} />
                  </div>
                  <span className="text-[10px] uppercase font-bold text-zinc-500 group-hover:text-zinc-300 transition-colors">
                    Only Matches
                  </span>
                </label>
              )}
            </div>
            
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
                      "p-2 md:p-4 font-mono font-bold",
                      s.transmitter === callA ? "text-orange-500" : "text-blue-500"
                    )}>{s.transmitter}</td>
                    <td className="p-2 md:p-4 font-mono text-zinc-300">{s.reporter}</td>
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
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div 
          className="absolute inset-0 bg-black/80 backdrop-blur-sm" 
          onClick={() => setIsHelpOpen(false)}
        />
        <div className="relative bg-[#151515] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-orange-500" />
              <h2 className="text-xl font-bold text-white">WSPR Antenna Lab Guide</h2>
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
                WSPR Antenna Lab is a specialized tool designed for radio amateurs to compare the real-world performance of two antennas. 
                By leveraging global WSPR (Weak Signal Propagation Reporter) data, it provides objective metrics on antenna gain and radiation patterns.
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">How to use</h3>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">1</div>
                  <p><strong className="text-zinc-200">Set Primary Station:</strong> Enter your callsign in "Callsign A". This is the antenna you are testing.</p>
                </div>
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">2</div>
                  <p><strong className="text-zinc-200">Select Reference:</strong> Choose a nearby station as "Callsign B". Ideally, this station should be within 50km and use a known antenna (like a dipole) for comparison.</p>
                </div>
                <div className="flex gap-4">
                  <div className="w-6 h-6 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center shrink-0 font-bold text-xs">3</div>
                  <p><strong className="text-zinc-200">Analyze:</strong> Select your band and time window, then click Update. The dashboard will calculate the relative gain difference.</p>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Key Concepts</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">SNR Normalization</h4>
                  <p className="text-xs">
                    Different stations use different power levels. We normalize data by subtracting the reported power (dBm) from the SNR. 
                    <code className="block mt-2 text-orange-500">SNR_norm = SNR - Power</code>
                  </p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                  <h4 className="text-zinc-200 font-bold mb-2">Antenna Delta ($\Delta G$)</h4>
                  <p className="text-xs">
                    This represents the average gain difference between your antenna and the reference. A +3dB delta means your antenna is performing twice as well as the reference.
                  </p>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-white font-bold uppercase tracking-wider text-xs">Visualizations</h3>
              <ul className="list-disc list-inside space-y-2 marker:text-orange-500">
                <li><strong className="text-zinc-200">Radiation Pattern:</strong> A smoothed polar chart showing gain at different azimuths. Use "Beamwidth" to adjust the smoothing sensitivity.</li>
                <li><strong className="text-zinc-200">Propagation Map:</strong> Real-time visualization of where your signal is reaching.</li>
                <li><strong className="text-zinc-200">Matches:</strong> A "Match" occurs when both A and B are heard by the same reporter in the same 2-minute WSPR slot. These are the most accurate data points for comparison.</li>
              </ul>
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
