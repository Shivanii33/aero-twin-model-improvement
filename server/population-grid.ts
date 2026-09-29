export type LandingZone = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  densityScore: number;
};

export type ScoredLandingZone = LandingZone & { distanceM: number };

// Demonstration-only density proxies near the fixed Bengaluru mission position; not surveyed landing sites.
const candidateZones: LandingZone[] = [
  { id: "L-01", name: "West open ground", lat: 12.9694, lng: 77.5738, densityScore: 9 },
  { id: "L-02", name: "North field", lat: 12.9931, lng: 77.5903, densityScore: 18 },
  { id: "L-03", name: "East greenbelt", lat: 12.9761, lng: 77.6159, densityScore: 22 },
  { id: "L-04", name: "South clearing", lat: 12.9478, lng: 77.5940, densityScore: 24 },
  { id: "L-05", name: "Northwest edge", lat: 12.9854, lng: 77.5683, densityScore: 4 },
  { id: "L-06", name: "Market perimeter", lat: 12.9662, lng: 77.6034, densityScore: 74 },
  { id: "L-07", name: "Central corridor", lat: 12.9748, lng: 77.5981, densityScore: 92 },
  { id: "L-08", name: "Southwest reserve", lat: 12.9557, lng: 77.5763, densityScore: 14 },
];

export function scoreLandingZones(currentLat: number, currentLng: number, safeRadiusM: number): ScoredLandingZone[] {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  return candidateZones
    .map((zone) => {
      const deltaLat = toRadians(zone.lat - currentLat);
      const deltaLng = toRadians(zone.lng - currentLng);
      const haversine = Math.sin(deltaLat / 2) ** 2 +
        Math.cos(toRadians(currentLat)) * Math.cos(toRadians(zone.lat)) * Math.sin(deltaLng / 2) ** 2;
      const distanceM = Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(haversine)));
      return { ...zone, distanceM };
    })
    .filter((zone) => zone.distanceM <= safeRadiusM)
    .sort((a, b) => a.densityScore - b.densityScore || a.distanceM - b.distanceM);
}
