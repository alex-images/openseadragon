/*
 * OpenSeadragon - Drawer
 *
 * Copyright (C) 2009 CodePlex Foundation
 * Copyright (C) 2010-2013 OpenSeadragon contributors
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * - Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * - Neither the name of CodePlex Foundation nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
 * TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

(function( $ ){

var DEVICE_SCREEN       = $.getWindowSize(),
    BROWSER             = $.Browser.vendor,
    BROWSER_VERSION     = $.Browser.version,

    SUBPIXEL_RENDERING = (
        ( BROWSER == $.BROWSERS.FIREFOX ) ||
        ( BROWSER == $.BROWSERS.OPERA )   ||
        ( BROWSER == $.BROWSERS.SAFARI && BROWSER_VERSION >= 4 ) ||
        ( BROWSER == $.BROWSERS.CHROME && BROWSER_VERSION >= 2 ) ||
        ( BROWSER == $.BROWSERS.IE     && BROWSER_VERSION >= 9 )
    );


/**
 * @class Drawer
 * @classdesc Handles rendering of tiles for an {@link OpenSeadragon.Viewer}.
 *
 * @memberof OpenSeadragon
 * @param {OpenSeadragon.TileSource} source - Reference to Viewer tile source.
 * @param {OpenSeadragon.Viewport} viewport - Reference to Viewer viewport.
 * @param {Element} element - Parent element.
 */
$.Drawer = function( options ) {
    var self = this;

    $.console.assert( options.viewer, "[Drawer] options.viewer is required" );

    //backward compatibility for positional args while prefering more
    //idiomatic javascript options object as the only argument
    var args  = arguments,
        i;

    if( !$.isPlainObject( options ) ){
        options = {
            source:     args[ 0 ], // Reference to Viewer tile source.
            viewport:   args[ 1 ], // Reference to Viewer viewport.
            element:    args[ 2 ]  // Parent element.
        };
    }

    if ( options.source ) {
        $.console.error( "[Drawer] options.source is no longer accepted; use TiledImage instead" );
    }

    $.extend( true, this, {

        //internal state properties
        viewer:         null,
        imageLoader:    new $.ImageLoader(),
        tilesMatrix:    {},    // A '3d' dictionary [level][x][y] --> Tile.
        tilesLoaded:    [],    // An unordered list of Tiles with loaded images.
        coverage:       {},    // A '3d' dictionary [level][x][y] --> Boolean.
        lastDrawn:      [],    // An unordered list of Tiles drawn last frame.
        lastResetTime:  0,     // Last time for which the drawer was reset.
        midUpdate:      false, // Is the drawer currently updating the viewport?
        updateAgain:    true,  // Does the drawer need to update the viewport again?


        //internal state / configurable settings
        collectionOverlays: {}, // For collection mode. Here an overlay is actually a viewer.

        //configurable settings
        opacity:            $.DEFAULT_SETTINGS.opacity,
        maxImageCacheCount: $.DEFAULT_SETTINGS.maxImageCacheCount,
        minZoomImageRatio:  $.DEFAULT_SETTINGS.minZoomImageRatio,
        wrapHorizontal:     $.DEFAULT_SETTINGS.wrapHorizontal,
        wrapVertical:       $.DEFAULT_SETTINGS.wrapVertical,
        immediateRender:    $.DEFAULT_SETTINGS.immediateRender,
        blendTime:          $.DEFAULT_SETTINGS.blendTime,
        alwaysBlend:        $.DEFAULT_SETTINGS.alwaysBlend,
        minPixelRatio:      $.DEFAULT_SETTINGS.minPixelRatio,
        debugMode:          $.DEFAULT_SETTINGS.debugMode,
        timeout:            $.DEFAULT_SETTINGS.timeout,
        crossOriginPolicy:  $.DEFAULT_SETTINGS.crossOriginPolicy

    }, options );

    this.useCanvas  = $.supportsCanvas && ( this.viewer ? this.viewer.useCanvas : true );
    /**
     * The parent element of this Drawer instance, passed in when the Drawer was created.
     * The parent of {@link OpenSeadragon.Drawer#canvas}.
     * @member {Element} container
     * @memberof OpenSeadragon.Drawer#
     */
    this.container  = $.getElement( this.element );
    /**
     * A &lt;canvas&gt; element if the browser supports them, otherwise a &lt;div&gt; element.
     * Child element of {@link OpenSeadragon.Drawer#container}.
     * @member {Element} canvas
     * @memberof OpenSeadragon.Drawer#
     */
    this.canvas     = $.makeNeutralElement( this.useCanvas ? "canvas" : "div" );
    /**
     * 2d drawing context for {@link OpenSeadragon.Drawer#canvas} if it's a &lt;canvas&gt; element, otherwise null.
     * @member {Object} context
     * @memberof OpenSeadragon.Drawer#
     */
    this.context    = this.useCanvas ? this.canvas.getContext( "2d" ) : null;

    /**
     * @member {Element} element
     * @memberof OpenSeadragon.Drawer#
     * @deprecated Alias for {@link OpenSeadragon.Drawer#container}.
     */
    this.element    = this.container;

    // We force our container to ltr because our drawing math doesn't work in rtl.
    // This issue only affects our canvas renderer, but we do it always for consistency.
    // Note that this means overlays you want to be rtl need to be explicitly set to rtl.
    this.container.dir = 'ltr';

    this.canvas.style.width     = "100%";
    this.canvas.style.height    = "100%";
    this.canvas.style.position  = "absolute";
    $.setElementOpacity( this.canvas, this.opacity, true );

    // explicit left-align
    this.container.style.textAlign = "left";
    this.container.appendChild( this.canvas );

    // We need a callback to give image manipulation a chance to happen
    this._drawingHandler = function(args) {
        if (self.viewer) {
          /**
           * This event is fired just before the tile is drawn giving the application a chance to alter the image.
           *
           * NOTE: This event is only fired when the drawer is using a <canvas>.
           *
           * @event tile-drawing
           * @memberof OpenSeadragon.Viewer
           * @type {object}
           * @property {OpenSeadragon.Viewer} eventSource - A reference to the Viewer which raised the event.
           * @property {OpenSeadragon.Tile} tile
           * @property {?Object} userData - 'context', 'tile' and 'rendered'.
           */
            self.viewer.raiseEvent('tile-drawing', args);
        }
    };
};

$.Drawer.prototype = /** @lends OpenSeadragon.Drawer.prototype */{

    /**
     * Adds an html element as an overlay to the current viewport.  Useful for
     * highlighting words or areas of interest on an image or other zoomable
     * interface.
     * @method
     * @param {Element|String|Object} element - A reference to an element or an id for
     *      the element which will overlayed. Or an Object specifying the configuration for the overlay
     * @param {OpenSeadragon.Point|OpenSeadragon.Rect} location - The point or
     *      rectangle which will be overlayed.
     * @param {OpenSeadragon.OverlayPlacement} placement - The position of the
     *      viewport which the location coordinates will be treated as relative
     *      to.
     * @param {function} onDraw - If supplied the callback is called when the overlay
     *      needs to be drawn. It it the responsibility of the callback to do any drawing/positioning.
     *      It is passed position, size and element.
     * @fires OpenSeadragon.Viewer.event:add-overlay
     * @deprecated - use {@link OpenSeadragon.Viewer#addOverlay} instead.
     */
    addOverlay: function( element, location, placement, onDraw ) {
        $.console.error("drawer.addOverlay is deprecated. Use viewer.addOverlay instead.");
        this.viewer.addOverlay( element, location, placement, onDraw );
        return this;
    },

    /**
     * Updates the overlay represented by the reference to the element or
     * element id moving it to the new location, relative to the new placement.
     * @method
     * @param {OpenSeadragon.Point|OpenSeadragon.Rect} location - The point or
     *      rectangle which will be overlayed.
     * @param {OpenSeadragon.OverlayPlacement} placement - The position of the
     *      viewport which the location coordinates will be treated as relative
     *      to.
     * @return {OpenSeadragon.Drawer} Chainable.
     * @fires OpenSeadragon.Viewer.event:update-overlay
     * @deprecated - use {@link OpenSeadragon.Viewer#updateOverlay} instead.
     */
    updateOverlay: function( element, location, placement ) {
        $.console.error("drawer.updateOverlay is deprecated. Use viewer.updateOverlay instead.");
        this.viewer.updateOverlay( element, location, placement );
        return this;
    },

    /**
     * Removes and overlay identified by the reference element or element id
     *      and schedules and update.
     * @method
     * @param {Element|String} element - A reference to the element or an
     *      element id which represent the ovelay content to be removed.
     * @return {OpenSeadragon.Drawer} Chainable.
     * @fires OpenSeadragon.Viewer.event:remove-overlay
     * @deprecated - use {@link OpenSeadragon.Viewer#removeOverlay} instead.
     */
    removeOverlay: function( element ) {
        $.console.error("drawer.removeOverlay is deprecated. Use viewer.removeOverlay instead.");
        this.viewer.removeOverlay( element );
        return this;
    },

    /**
     * Removes all currently configured Overlays from this Drawer and schedules
     *      and update.
     * @method
     * @return {OpenSeadragon.Drawer} Chainable.
     * @fires OpenSeadragon.Viewer.event:clear-overlay
     * @deprecated - use {@link OpenSeadragon.Viewer#clearOverlays} instead.
     */
    clearOverlays: function() {
        $.console.error("drawer.clearOverlays is deprecated. Use viewer.clearOverlays instead.");
        this.viewer.clearOverlays();
        return this;
    },

    /**
     * Set the opacity of the drawer.
     * @method
     * @param {Number} opacity
     * @return {OpenSeadragon.Drawer} Chainable.
     */
    setOpacity: function( opacity ) {
        this.opacity = opacity;
        $.setElementOpacity( this.canvas, this.opacity, true );
        return this;
    },

    /**
     * Get the opacity of the drawer.
     * @method
     * @returns {Number}
     */
    getOpacity: function() {
        return this.opacity;
    },
    /**
     * Returns whether the Drawer is scheduled for an update at the
     *      soonest possible opportunity.
     * @method
     * @returns {Boolean} - Whether the Drawer is scheduled for an update at the
     *      soonest possible opportunity.
     */
    needsUpdate: function() {
        return this.updateAgain;
    },

    /**
     * Returns the total number of tiles that have been loaded by this Drawer.
     * @method
     * @returns {Number} - The total number of tiles that have been loaded by
     *      this Drawer.
     */
    numTilesLoaded: function() {
        return this.tilesLoaded.length;
    },

    /**
     * Clears all tiles and triggers an update on the next call to
     * Drawer.prototype.update().
     * @method
     * @return {OpenSeadragon.Drawer} Chainable.
     */
    reset: function() {
        clearTiles( this );
        this.lastResetTime = $.now();
        this.updateAgain = true;
        return this;
    },

    /**
     * Forces the Drawer to update.
     * @method
     * @return {OpenSeadragon.Drawer} Chainable.
     */
    update: function() {
        //this.profiler.beginUpdate();
        this.midUpdate = true;
        updateViewport( this );
        this.midUpdate = false;
        //this.profiler.endUpdate();
        return this;
    },

    /**
     * Returns whether rotation is supported or not.
     * @method
     * @return {Boolean} True if rotation is supported.
     */
    canRotate: function() {
        return this.useCanvas;
    },

    /**
     * Destroy the drawer (unload current loaded tiles)
     * @method
     * @return null
     */
    destroy: function() {
        //unload current loaded tiles (=empty TILE_CACHE)
        for ( var i = 0; i < this.tilesLoaded.length; ++i ) {
            this.tilesLoaded[i].unload();
        }

        //force unloading of current canvas (1x1 will be gc later, trick not necessarily needed)
        this.canvas.width  = 1;
        this.canvas.height = 1;
    },

    clear: function() {
        this.canvas.innerHTML = "";
        if ( this.useCanvas ) {
            var viewportSize = this.viewport.getContainerSize();
            if( this.canvas.width != viewportSize.x ||
                this.canvas.height != viewportSize.y ) {
                this.canvas.width = viewportSize.x;
                this.canvas.height = viewportSize.y;
            }
            this.context.clearRect( 0, 0, viewportSize.x, viewportSize.y );
        }
    },

    drawTile: function( tile ) {
        if ( this.useCanvas ) {
            // TODO do this in a more performant way
            // specifically, don't save,rotate,restore every time we draw a tile
            if( this.viewport.degrees !== 0 ) {
                this._offsetForRotation( tile, this.viewport.degrees );
                tile.drawCanvas( this.context, this._drawingHandler );
                this._restoreRotationChanges( tile );
            } else {
                tile.drawCanvas( this.context, this._drawingHandler );
            }
        } else {
            tile.drawHTML( this.canvas );
        }
    },

    drawDebugInfo: function( tile, count, i ){
        if ( this.useCanvas ) {
            this.context.save();
            this.context.lineWidth = 2;
            this.context.font = 'small-caps bold 13px ariel';
            this.context.strokeStyle = this.debugGridColor;
            this.context.fillStyle = this.debugGridColor;
            this.context.strokeRect(
                tile.position.x,
                tile.position.y,
                tile.size.x,
                tile.size.y
            );
            if( tile.x === 0 && tile.y === 0 ){
                this.context.fillText(
                    "Zoom: " + this.viewport.getZoom(),
                    tile.position.x,
                    tile.position.y - 30
                );
                this.context.fillText(
                    "Pan: " + this.viewport.getBounds().toString(),
                    tile.position.x,
                    tile.position.y - 20
                );
            }
            this.context.fillText(
                "Level: " + tile.level,
                tile.position.x + 10,
                tile.position.y + 20
            );
            this.context.fillText(
                "Column: " + tile.x,
                tile.position.x + 10,
                tile.position.y + 30
            );
            this.context.fillText(
                "Row: " + tile.y,
                tile.position.x + 10,
                tile.position.y + 40
            );
            this.context.fillText(
                "Order: " + i + " of " + count,
                tile.position.x + 10,
                tile.position.y + 50
            );
            this.context.fillText(
                "Size: " + tile.size.toString(),
                tile.position.x + 10,
                tile.position.y + 60
            );
            this.context.fillText(
                "Position: " + tile.position.toString(),
                tile.position.x + 10,
                tile.position.y + 70
            );
            this.context.restore();
        }
    },

    _offsetForRotation: function( tile, degrees ){
        var cx = this.canvas.width / 2,
            cy = this.canvas.height / 2,
            px = tile.position.x - cx,
            py = tile.position.y - cy;

        this.context.save();

        this.context.translate(cx, cy);
        this.context.rotate( Math.PI / 180 * degrees);
        tile.position.x = px;
        tile.position.y = py;
    },

    _restoreRotationChanges: function( tile ){
        var cx = this.canvas.width / 2,
            cy = this.canvas.height / 2,
            px = tile.position.x + cx,
            py = tile.position.y + cy;

        tile.position.x = px;
        tile.position.y = py;

        this.context.restore();
    }
};

}( OpenSeadragon ));
