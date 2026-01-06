import * as Cesium from "cesium"
import { PlaneGeometry, MeshBasicMaterial, Mesh, TextureLoader } from "three"

export default class CesiumTerrain {
  constructor(scene) {
    this.scene = scene
    this.terrainProvider = null
    this.sampledPositions = new Map() // Cache for elevation queries
    
    // Initialize Cesium's terrain provider (uses Cesium World Terrain)
    this.terrainProvider = Cesium.createWorldTerrainAsync({
      requestWaterMask: false,
      requestVertexNormals: false
    })
    
    console.log("Cesium terrain provider initialized")
    
    // Create a simple ground plane for visual reference
    this.createGroundPlane()
  }
  
  createGroundPlane() {
    const geometry = new PlaneGeometry(1000000, 1000000, 100, 100)
    const material = new MeshBasicMaterial({ 
      color: 0x4a7c59,
      wireframe: false
    })
    
    this.groundMesh = new Mesh(geometry, material)
    this.groundMesh.rotateX(-Math.PI / 2)
    this.groundMesh.position.set(0, -100, 0) // Place below start altitude
    this.scene.add(this.groundMesh)
  }
  
  /**
   * Get elevation at a specific point using Cesium terrain
   * @param {number} longitude - in degrees
   * @param {number} latitude - in degrees
   * @returns {Promise<number>} elevation in meters
   */
  async getElevation(longitude, latitude) {
    const cacheKey = `${longitude.toFixed(6)},${latitude.toFixed(6)}`
    
    // Check cache first
    if (this.sampledPositions.has(cacheKey)) {
      return this.sampledPositions.get(cacheKey)
    }
    
    try {
      const provider = await this.terrainProvider
      const positions = [
        Cesium.Cartographic.fromDegrees(longitude, latitude)
      ]
      
      const updatedPositions = await Cesium.sampleTerrainMostDetailed(provider, positions)
      const elevation = updatedPositions[0].height || 0
      
      // Cache the result
      this.sampledPositions.set(cacheKey, elevation)
      
      return elevation
    } catch (error) {
      console.warn("Error sampling terrain elevation:", error)
      return 0 // Return sea level on error
    }
  }
  
  /**
   * Convert UTM33 coordinates to lat/lon
   * @param {number} east - UTM easting
   * @param {number} north - UTM northing
   * @returns {Object} {longitude, latitude}
   */
  utmToLatLon(east, north) {
    // UTM Zone 33N projection (this is what the original sim uses)
    // For simplicity, we'll use Cesium's built-in conversion
    const cartographic = Cesium.Cartographic.fromCartesian(
      Cesium.Cartesian3.fromDegrees(
        (east - 500000) / 111320, // Rough conversion
        north / 111320
      )
    )
    
    return {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude)
    }
  }
  
  /**
   * Get elevation at UTM coordinates
   * @param {number} east - UTM easting
   * @param {number} north - UTM northing
   * @returns {Promise<number>} elevation in meters
   */
  async getElevationAtUTM(east, north) {
    // For Norway (UTM Zone 33N), rough conversion
    // In production, you'd use proj4 for accurate conversion
    const longitude = (east - 500000) / 111320
    const latitude = north / 111320
    
    return this.getElevation(longitude, latitude)
  }
  
  update(camera, showWireFrame) {
    // Cesium handles terrain loading automatically
    // No manual tile management needed
    if (this.groundMesh) {
      this.groundMesh.material.wireframe = showWireFrame
    }
  }
}
