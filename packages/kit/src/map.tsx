import 'leaflet/dist/leaflet.css'
import { type Layer, type Map as LeafletMap, circleMarker, latLngBounds, map, polyline, tileLayer } from 'leaflet'
import { useEffect, useRef } from 'react'
import { type MapSpec, mapPoints } from './specs.ts'

/**
 * OpenStreetMap's standard tiles, under its tile usage policy (light use, attribution shown). `kit.css` tones them to
 * the theme; the markers and lines above them keep their colours.
 */
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const color = (index: number) => `var(--chart-${(index % 5) + 1})`
const PADDING: [number, number] = [24, 24]
const latLng = ([lat, lng]: readonly [number, number]): [number, number] => [lat, lng]

/**
 * On a touch screen one finger scrolls the page past the map instead of panning it (Leaflet's drag would otherwise
 * claim every touch that starts on it); two fingers still pinch to zoom and pan.
 */
const touch = () => window.matchMedia('(pointer: coarse)').matches

/** A label from the spec as a tooltip. Leaflet would read a string as HTML; a text node keeps model text inert. */
function labelled(layer: Layer, label: string | undefined, sticky: boolean): Layer {
  if (label === undefined) return layer
  const text = document.createElement('span')
  text.textContent = label
  return layer.bindTooltip(text, { sticky })
}

/** Opens where the spec says: fitted around everything it shows, or at its center and zoom. */
function place(view: LeafletMap, spec: MapSpec): void {
  const points = mapPoints(spec)
  if (spec.zoom === undefined && points.length > 1)
    view.fitBounds(latLngBounds(points.map(latLng)), { padding: PADDING })
  else view.setView(latLng(points[0] ?? [0, 0]), spec.zoom ?? 11)
}

/** The map itself, made when it mounts and removed when it unmounts; its spec is the one it mounted with. */
function MapCanvas({ spec }: { readonly spec: MapSpec }) {
  const canvas = useRef<HTMLDivElement>(null)
  const mounted = useRef(spec)
  useEffect(() => {
    const element = canvas.current
    if (element === null) return
    const shown = mounted.current
    const view = map(element, { scrollWheelZoom: false, dragging: !touch() })
    tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(view)
    for (const [index, line] of (shown.lines ?? []).entries())
      labelled(polyline(line.points.map(latLng), { color: color(index + 1), weight: 3 }), line.label, true).addTo(view)
    for (const marker of shown.markers ?? [])
      labelled(
        circleMarker([marker.lat, marker.lng], {
          radius: 7,
          color: 'var(--background)',
          weight: 2,
          fillColor: color(0),
          fillOpacity: 1,
        }),
        marker.label,
        false,
      ).addTo(view)
    place(view, shown)
    return () => {
      view.remove()
    }
  }, [])
  return <div ref={canvas} className="kit-map-canvas" />
}

/**
 * A map drawn from a spec on Leaflet itself (ADR 0130): markers in the first chart colour, each line in the next;
 * labels show on hover or tap. A spec with other content is a new map.
 */
export function MapView({ spec }: { readonly spec: MapSpec }) {
  return (
    <figure className="kit-map">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <MapCanvas key={JSON.stringify(spec)} spec={spec} />
    </figure>
  )
}
