(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.muxjs = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2016 Brightcove
 * All rights reserved.
 *
 * A stream-based aac to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */
'use strict';
var Stream = require('../utils/stream.js');

// Constants
var AacStream;

/**
 * Splits an incoming stream of binary data into ADTS and ID3 Frames.
 */

AacStream = function() {
  var
    everything = new Uint8Array(),
    receivedTimeStamp = false,
    timeStamp = 0;

  AacStream.prototype.init.call(this);

  this.setTimestamp = function (timestamp) {
    timeStamp = timestamp;
  };

  this.parseId3TagSize = function(header, byteIndex) {
    var
      returnSize = (header[byteIndex + 6] << 21) |
                   (header[byteIndex + 7] << 14) |
                   (header[byteIndex + 8] << 7) |
                   (header[byteIndex + 9]),
      flags = header[byteIndex + 5],
      footerPresent = (flags & 16) >> 4;

    if (footerPresent) {
      return returnSize + 20;
    }
    return returnSize + 10;
  };

  this.parseAdtsSize = function(header, byteIndex) {
    var
      lowThree = (header[byteIndex + 5] & 0xE0) >> 5,
      middle = header[byteIndex + 4] << 3,
      highTwo = header[byteIndex + 3] & 0x3 << 11;

    return (highTwo | middle) | lowThree;
  };

  this.push = function(bytes) {
    var
      frameSize = 0,
      byteIndex = 0,
      bytesLeft,
      chunk,
      packet,
      tempLength;

    // If there are bytes remaining from the last segment, prepend them to the
    // bytes that were pushed in
    if (everything.length) {
      tempLength = everything.length;
      everything = new Uint8Array(bytes.byteLength + tempLength);
      everything.set(everything.subarray(0, tempLength));
      everything.set(bytes, tempLength);
    } else {
      everything = bytes;
    }

    while (everything.length - byteIndex >= 3) {
      if ((everything[byteIndex] === 'I'.charCodeAt(0)) &&
          (everything[byteIndex + 1] === 'D'.charCodeAt(0)) &&
          (everything[byteIndex + 2] === '3'.charCodeAt(0))) {

        // Exit early because we don't have enough to parse
        // the ID3 tag header
        if (everything.length - byteIndex < 10) {
          break;
        }

        // check framesize
        frameSize = this.parseId3TagSize(everything, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        if (frameSize > everything.length) {
          break;
        }
        chunk = {
          type: 'timed-metadata',
          data: everything.subarray(byteIndex, byteIndex + frameSize)
        };
        this.trigger('data', chunk);
        byteIndex += frameSize;
        continue;
      } else if ((everything[byteIndex] & 0xff === 0xff) &&
                 ((everything[byteIndex + 1] & 0xf0) === 0xf0)) {

        // Exit early because we don't have enough to parse
        // the ADTS frame header
        if (everything.length - byteIndex < 7) {
          break;
        }

        frameSize = this.parseAdtsSize(everything, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        if (frameSize > everything.length) {
          break;
        }

        packet = {
          type: 'audio',
          data: everything.subarray(byteIndex, byteIndex + frameSize),
          pts: timeStamp,
          dts: timeStamp,
        };
        this.trigger('data', packet);
        byteIndex += frameSize;
        continue;
      }
      byteIndex++;
    }
    bytesLeft = everything.length - byteIndex;

    if (bytesLeft > 0) {
      everything = everything.subarray(byteIndex);
    } else {
      everything = new Uint8Array();
    }
  };
};

AacStream.prototype = new Stream();



module.exports = AacStream;

},{"../utils/stream.js":20}],2:[function(require,module,exports){
'use strict';

var Stream = require('../utils/stream.js');

var AdtsStream;

var
  ADTS_SAMPLING_FREQUENCIES = [
    96000,
    88200,
    64000,
    48000,
    44100,
    32000,
    24000,
    22050,
    16000,
    12000,
    11025,
    8000,
    7350
  ];

/*
 * Accepts a ElementaryStream and emits data events with parsed
 * AAC Audio Frames of the individual packets. Input audio in ADTS
 * format is unpacked and re-emitted as AAC frames.
 *
 * @see http://wiki.multimedia.cx/index.php?title=ADTS
 * @see http://wiki.multimedia.cx/?title=Understanding_AAC
 */
AdtsStream = function() {
  var self, buffer;

  AdtsStream.prototype.init.call(this);

  self = this;

  this.push = function(packet) {
    var
      i = 0,
      frameNum = 0,
      frameLength,
      protectionSkipBytes,
      frameEnd,
      oldBuffer,
      numFrames,
      sampleCount,
      adtsFrameDuration;

    if (packet.type !== 'audio') {
      // ignore non-audio data
      return;
    }

    // Prepend any data in the buffer to the input data so that we can parse
    // aac frames the cross a PES packet boundary
    if (buffer) {
      oldBuffer = buffer;
      buffer = new Uint8Array(oldBuffer.byteLength + packet.data.byteLength);
      buffer.set(oldBuffer);
      buffer.set(packet.data, oldBuffer.byteLength);
    } else {
      buffer = packet.data;
    }

    // unpack any ADTS frames which have been fully received
    // for details on the ADTS header, see http://wiki.multimedia.cx/index.php?title=ADTS
    while (i + 5 < buffer.length) {

      // Loook for the start of an ADTS header..
      if (buffer[i] !== 0xFF || (buffer[i + 1] & 0xF6) !== 0xF0) {
        // If a valid header was not found,  jump one forward and attempt to
        // find a valid ADTS header starting at the next byte
        i++;
        continue;
      }

      // The protection skip bit tells us if we have 2 bytes of CRC data at the
      // end of the ADTS header
      protectionSkipBytes = (~buffer[i + 1] & 0x01) * 2;

      // Frame length is a 13 bit integer starting 16 bits from the
      // end of the sync sequence
      frameLength = ((buffer[i + 3] & 0x03) << 11) |
        (buffer[i + 4] << 3) |
        ((buffer[i + 5] & 0xe0) >> 5);

      sampleCount = ((buffer[i + 6] & 0x03) + 1) * 1024;
      adtsFrameDuration = (sampleCount * 90000) /
        ADTS_SAMPLING_FREQUENCIES[(buffer[i + 2] & 0x3c) >>> 2];

      frameEnd = i + frameLength;

      // If we don't have enough data to actually finish this ADTS frame, return
      // and wait for more data
      if (buffer.byteLength < frameEnd) {
        return;
      }

      // Otherwise, deliver the complete AAC frame
      this.trigger('data', {
        pts: packet.pts + (frameNum * adtsFrameDuration),
        dts: packet.dts + (frameNum * adtsFrameDuration),
        sampleCount: sampleCount,
        audioobjecttype: ((buffer[i + 2] >>> 6) & 0x03) + 1,
        channelcount: ((buffer[i + 2] & 1) << 2) |
          ((buffer[i + 3] & 0xc0) >>> 6),
        samplerate: ADTS_SAMPLING_FREQUENCIES[(buffer[i + 2] & 0x3c) >>> 2],
        samplingfrequencyindex: (buffer[i + 2] & 0x3c) >>> 2,
        // assume ISO/IEC 14496-12 AudioSampleEntry default of 16
        samplesize: 16,
        data: buffer.subarray(i + 7 + protectionSkipBytes, frameEnd)
      });

      // If the buffer is empty, clear it and return
      if (buffer.byteLength === frameEnd) {
        buffer = undefined;
        return;
      }

      frameNum++;

      // Remove the finished frame from the buffer and start the process again
      buffer = buffer.subarray(frameEnd);
    }
  };
  this.flush = function() {
    this.trigger('done');
  };
};

AdtsStream.prototype = new Stream();

module.exports = AdtsStream;

},{"../utils/stream.js":20}],3:[function(require,module,exports){
'use strict';

var Stream = require('../utils/stream.js');
var ExpGolomb = require('../utils/exp-golomb.js');

var H264Stream, NalByteStream;

/**
 * Accepts a NAL unit byte stream and unpacks the embedded NAL units.
 */
NalByteStream = function() {
  var
    syncPoint = 0,
    i,
    buffer;
  NalByteStream.prototype.init.call(this);

  this.push = function(data) {
    var swapBuffer;

    if (!buffer) {
      buffer = data.data;
    } else {
      swapBuffer = new Uint8Array(buffer.byteLength + data.data.byteLength);
      swapBuffer.set(buffer);
      swapBuffer.set(data.data, buffer.byteLength);
      buffer = swapBuffer;
    }

    // Rec. ITU-T H.264, Annex B
    // scan for NAL unit boundaries

    // a match looks like this:
    // 0 0 1 .. NAL .. 0 0 1
    // ^ sync point        ^ i
    // or this:
    // 0 0 1 .. NAL .. 0 0 0
    // ^ sync point        ^ i

    // advance the sync point to a NAL start, if necessary
    for (; syncPoint < buffer.byteLength - 3; syncPoint++) {
      if (buffer[syncPoint + 2] === 1) {
        // the sync point is properly aligned
        i = syncPoint + 5;
        break;
      }
    }

    while (i < buffer.byteLength) {
      // look at the current byte to determine if we've hit the end of
      // a NAL unit boundary
      switch (buffer[i]) {
      case 0:
        // skip past non-sync sequences
        if (buffer[i - 1] !== 0) {
          i += 2;
          break;
        } else if (buffer[i - 2] !== 0) {
          i++;
          break;
        }

        // deliver the NAL unit if it isn't empty
        if (syncPoint + 3 !==  i - 2) {
          this.trigger('data', buffer.subarray(syncPoint + 3, i - 2));
        }

        // drop trailing zeroes
        do {
          i++;
        } while (buffer[i] !== 1 && i < buffer.length);
        syncPoint = i - 2;
        i += 3;
        break;
      case 1:
        // skip past non-sync sequences
        if (buffer[i - 1] !== 0 ||
            buffer[i - 2] !== 0) {
          i += 3;
          break;
        }

        // deliver the NAL unit
        this.trigger('data', buffer.subarray(syncPoint + 3, i - 2));
        syncPoint = i - 2;
        i += 3;
        break;
      default:
        // the current byte isn't a one or zero, so it cannot be part
        // of a sync sequence
        i += 3;
        break;
      }
    }
    // filter out the NAL units that were delivered
    buffer = buffer.subarray(syncPoint);
    i -= syncPoint;
    syncPoint = 0;
  };

  this.flush = function() {
    // deliver the last buffered NAL unit
    if (buffer && buffer.byteLength > 3) {
      this.trigger('data', buffer.subarray(syncPoint + 3));
    }
    // reset the stream state
    buffer = null;
    syncPoint = 0;
    this.trigger('done');
  };
};
NalByteStream.prototype = new Stream();

/**
 * Accepts input from a ElementaryStream and produces H.264 NAL unit data
 * events.
 */
H264Stream = function() {
  var
    nalByteStream = new NalByteStream(),
    self,
    trackId,
    currentPts,
    currentDts,

    discardEmulationPreventionBytes,
    readSequenceParameterSet,
    skipScalingList;

  H264Stream.prototype.init.call(this);
  self = this;

  this.push = function(packet) {
    if (packet.type !== 'video') {
      return;
    }
    trackId = packet.trackId;
    currentPts = packet.pts;
    currentDts = packet.dts;

    nalByteStream.push(packet);
  };

  nalByteStream.on('data', function(data) {
    var
      event = {
        trackId: trackId,
        pts: currentPts,
        dts: currentDts,
        data: data
      };

    switch (data[0] & 0x1f) {
    case 0x05:
      event.nalUnitType = 'slice_layer_without_partitioning_rbsp_idr';
      break;
    case 0x06:
      event.nalUnitType = 'sei_rbsp';
      event.escapedRBSP = discardEmulationPreventionBytes(data.subarray(1));
      break;
    case 0x07:
      event.nalUnitType = 'seq_parameter_set_rbsp';
      event.escapedRBSP = discardEmulationPreventionBytes(data.subarray(1));
      event.config = readSequenceParameterSet(event.escapedRBSP);
      break;
    case 0x08:
      event.nalUnitType = 'pic_parameter_set_rbsp';
      break;
    case 0x09:
      event.nalUnitType = 'access_unit_delimiter_rbsp';
      break;

    default:
      break;
    }
    self.trigger('data', event);
  });
  nalByteStream.on('done', function() {
    self.trigger('done');
  });

  this.flush = function() {
    nalByteStream.flush();
  };

  /**
   * Advance the ExpGolomb decoder past a scaling list. The scaling
   * list is optionally transmitted as part of a sequence parameter
   * set and is not relevant to transmuxing.
   * @param count {number} the number of entries in this scaling list
   * @param expGolombDecoder {object} an ExpGolomb pointed to the
   * start of a scaling list
   * @see Recommendation ITU-T H.264, Section 7.3.2.1.1.1
   */
  skipScalingList = function(count, expGolombDecoder) {
    var
      lastScale = 8,
      nextScale = 8,
      j,
      deltaScale;

    for (j = 0; j < count; j++) {
      if (nextScale !== 0) {
        deltaScale = expGolombDecoder.readExpGolomb();
        nextScale = (lastScale + deltaScale + 256) % 256;
      }

      lastScale = (nextScale === 0) ? lastScale : nextScale;
    }
  };

  /**
   * Expunge any "Emulation Prevention" bytes from a "Raw Byte
   * Sequence Payload"
   * @param data {Uint8Array} the bytes of a RBSP from a NAL
   * unit
   * @return {Uint8Array} the RBSP without any Emulation
   * Prevention Bytes
   */
  discardEmulationPreventionBytes = function(data) {
    var
      length = data.byteLength,
      emulationPreventionBytesPositions = [],
      i = 1,
      newLength, newData;

    // Find all `Emulation Prevention Bytes`
    while (i < length - 2) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0x03) {
        emulationPreventionBytesPositions.push(i + 2);
        i += 2;
      } else {
        i++;
      }
    }

    // If no Emulation Prevention Bytes were found just return the original
    // array
    if (emulationPreventionBytesPositions.length === 0) {
      return data;
    }

    // Create a new array to hold the NAL unit data
    newLength = length - emulationPreventionBytesPositions.length;
    newData = new Uint8Array(newLength);
    var sourceIndex = 0;

    for (i = 0; i < newLength; sourceIndex++, i++) {
      if (sourceIndex === emulationPreventionBytesPositions[0]) {
        // Skip this byte
        sourceIndex++;
        // Remove this position index
        emulationPreventionBytesPositions.shift();
      }
      newData[i] = data[sourceIndex];
    }

    return newData;
  };

  /**
   * Read a sequence parameter set and return some interesting video
   * properties. A sequence parameter set is the H264 metadata that
   * describes the properties of upcoming video frames.
   * @param data {Uint8Array} the bytes of a sequence parameter set
   * @return {object} an object with configuration parsed from the
   * sequence parameter set, including the dimensions of the
   * associated video frames.
   */
  readSequenceParameterSet = function(data) {
    var
      frameCropLeftOffset = 0,
      frameCropRightOffset = 0,
      frameCropTopOffset = 0,
      frameCropBottomOffset = 0,
      sarScale = 1,
      expGolombDecoder, profileIdc, levelIdc, profileCompatibility,
      chromaFormatIdc, picOrderCntType,
      numRefFramesInPicOrderCntCycle, picWidthInMbsMinus1,
      picHeightInMapUnitsMinus1,
      frameMbsOnlyFlag,
      scalingListCount,
      sarRatio,
      aspectRatioIdc,
      i;

    expGolombDecoder = new ExpGolomb(data);
    profileIdc = expGolombDecoder.readUnsignedByte(); // profile_idc
    profileCompatibility = expGolombDecoder.readUnsignedByte(); // constraint_set[0-5]_flag
    levelIdc = expGolombDecoder.readUnsignedByte(); // level_idc u(8)
    expGolombDecoder.skipUnsignedExpGolomb(); // seq_parameter_set_id

    // some profiles have more optional data we don't need
    if (profileIdc === 100 ||
        profileIdc === 110 ||
        profileIdc === 122 ||
        profileIdc === 244 ||
        profileIdc ===  44 ||
        profileIdc ===  83 ||
        profileIdc ===  86 ||
        profileIdc === 118 ||
        profileIdc === 128 ||
        profileIdc === 138 ||
        profileIdc === 139 ||
        profileIdc === 134) {
      chromaFormatIdc = expGolombDecoder.readUnsignedExpGolomb();
      if (chromaFormatIdc === 3) {
        expGolombDecoder.skipBits(1); // separate_colour_plane_flag
      }
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_luma_minus8
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_chroma_minus8
      expGolombDecoder.skipBits(1); // qpprime_y_zero_transform_bypass_flag
      if (expGolombDecoder.readBoolean()) { // seq_scaling_matrix_present_flag
        scalingListCount = (chromaFormatIdc !== 3) ? 8 : 12;
        for (i = 0; i < scalingListCount; i++) {
          if (expGolombDecoder.readBoolean()) { // seq_scaling_list_present_flag[ i ]
            if (i < 6) {
              skipScalingList(16, expGolombDecoder);
            } else {
              skipScalingList(64, expGolombDecoder);
            }
          }
        }
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // log2_max_frame_num_minus4
    picOrderCntType = expGolombDecoder.readUnsignedExpGolomb();

    if (picOrderCntType === 0) {
      expGolombDecoder.readUnsignedExpGolomb(); //log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      expGolombDecoder.skipBits(1); // delta_pic_order_always_zero_flag
      expGolombDecoder.skipExpGolomb(); // offset_for_non_ref_pic
      expGolombDecoder.skipExpGolomb(); // offset_for_top_to_bottom_field
      numRefFramesInPicOrderCntCycle = expGolombDecoder.readUnsignedExpGolomb();
      for(i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        expGolombDecoder.skipExpGolomb(); // offset_for_ref_frame[ i ]
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // max_num_ref_frames
    expGolombDecoder.skipBits(1); // gaps_in_frame_num_value_allowed_flag

    picWidthInMbsMinus1 = expGolombDecoder.readUnsignedExpGolomb();
    picHeightInMapUnitsMinus1 = expGolombDecoder.readUnsignedExpGolomb();

    frameMbsOnlyFlag = expGolombDecoder.readBits(1);
    if (frameMbsOnlyFlag === 0) {
      expGolombDecoder.skipBits(1); // mb_adaptive_frame_field_flag
    }

    expGolombDecoder.skipBits(1); // direct_8x8_inference_flag
    if (expGolombDecoder.readBoolean()) { // frame_cropping_flag
      frameCropLeftOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropRightOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropTopOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropBottomOffset = expGolombDecoder.readUnsignedExpGolomb();
    }
    if (expGolombDecoder.readBoolean()) {
      // vui_parameters_present_flag
      if (expGolombDecoder.readBoolean()) {
        // aspect_ratio_info_present_flag
        aspectRatioIdc = expGolombDecoder.readUnsignedByte();
        switch (aspectRatioIdc) {
          case 1: sarRatio = [1,1]; break;
          case 2: sarRatio = [12,11]; break;
          case 3: sarRatio = [10,11]; break;
          case 4: sarRatio = [16,11]; break;
          case 5: sarRatio = [40,33]; break;
          case 6: sarRatio = [24,11]; break;
          case 7: sarRatio = [20,11]; break;
          case 8: sarRatio = [32,11]; break;
          case 9: sarRatio = [80,33]; break;
          case 10: sarRatio = [18,11]; break;
          case 11: sarRatio = [15,11]; break;
          case 12: sarRatio = [64,33]; break;
          case 13: sarRatio = [160,99]; break;
          case 14: sarRatio = [4,3]; break;
          case 15: sarRatio = [3,2]; break;
          case 16: sarRatio = [2,1]; break;
          case 255: {
            sarRatio = [expGolombDecoder.readUnsignedByte() << 8 |
                        expGolombDecoder.readUnsignedByte(),
                        expGolombDecoder.readUnsignedByte() << 8 |
                        expGolombDecoder.readUnsignedByte() ];
            break;
          }
        }
        if (sarRatio) {
          sarScale = sarRatio[0] / sarRatio[1];
        }
      }
    }
    return {
      profileIdc: profileIdc,
      levelIdc: levelIdc,
      profileCompatibility: profileCompatibility,
      width: Math.ceil((((picWidthInMbsMinus1 + 1) * 16) - frameCropLeftOffset * 2 - frameCropRightOffset * 2) * sarScale),
      height: ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (frameCropTopOffset * 2) - (frameCropBottomOffset * 2)
    };
  };

};
H264Stream.prototype = new Stream();

module.exports = {
  H264Stream: H264Stream,
  NalByteStream: NalByteStream,
};

},{"../utils/exp-golomb.js":19,"../utils/stream.js":20}],4:[function(require,module,exports){
module.exports = {
  adts: require('./adts'),
  h264: require('./h264'),
};

},{"./adts":2,"./h264":3}],5:[function(require,module,exports){
/**
 * An object that stores the bytes of an FLV tag and methods for
 * querying and manipulating that data.
 * @see http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf
 */
'use strict';

var FlvTag;

// (type:uint, extraData:Boolean = false) extends ByteArray
FlvTag = function(type, extraData) {
  var
    // Counter if this is a metadata tag, nal start marker if this is a video
    // tag. unused if this is an audio tag
    adHoc = 0, // :uint

    // The default size is 16kb but this is not enough to hold iframe
    // data and the resizing algorithm costs a bit so we create a larger
    // starting buffer for video tags
    bufferStartSize = 16384,

    // checks whether the FLV tag has enough capacity to accept the proposed
    // write and re-allocates the internal buffers if necessary
    prepareWrite = function(flv, count) {
      var
        bytes,
        minLength = flv.position + count;
      if (minLength < flv.bytes.byteLength) {
        // there's enough capacity so do nothing
        return;
      }

      // allocate a new buffer and copy over the data that will not be modified
      bytes = new Uint8Array(minLength * 2);
      bytes.set(flv.bytes.subarray(0, flv.position), 0);
      flv.bytes = bytes;
      flv.view = new DataView(flv.bytes.buffer);
    },

    // commonly used metadata properties
    widthBytes = FlvTag.widthBytes || new Uint8Array('width'.length),
    heightBytes = FlvTag.heightBytes || new Uint8Array('height'.length),
    videocodecidBytes = FlvTag.videocodecidBytes || new Uint8Array('videocodecid'.length),
    i;

  if (!FlvTag.widthBytes) {
    // calculating the bytes of common metadata names ahead of time makes the
    // corresponding writes faster because we don't have to loop over the
    // characters
    // re-test with test/perf.html if you're planning on changing this
    for (i = 0; i < 'width'.length; i++) {
      widthBytes[i] = 'width'.charCodeAt(i);
    }
    for (i = 0; i < 'height'.length; i++) {
      heightBytes[i] = 'height'.charCodeAt(i);
    }
    for (i = 0; i < 'videocodecid'.length; i++) {
      videocodecidBytes[i] = 'videocodecid'.charCodeAt(i);
    }

    FlvTag.widthBytes = widthBytes;
    FlvTag.heightBytes = heightBytes;
    FlvTag.videocodecidBytes = videocodecidBytes;
  }

  this.keyFrame = false; // :Boolean

  switch(type) {
  case FlvTag.VIDEO_TAG:
    this.length = 16;
    // Start the buffer at 256k
    bufferStartSize *= 6;
    break;
  case FlvTag.AUDIO_TAG:
    this.length = 13;
    this.keyFrame = true;
    break;
  case FlvTag.METADATA_TAG:
    this.length = 29;
    this.keyFrame = true;
    break;
  default:
    throw("Error Unknown TagType");
  }

  this.bytes = new Uint8Array(bufferStartSize);
  this.view = new DataView(this.bytes.buffer);
  this.bytes[0] = type;
  this.position = this.length;
  this.keyFrame = extraData; // Defaults to false

  // presentation timestamp
  this.pts = 0;
  // decoder timestamp
  this.dts = 0;

  // ByteArray#writeBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0)
  this.writeBytes = function(bytes, offset, length) {
    var
      start = offset || 0,
      end;
    length = length || bytes.byteLength;
    end = start + length;

    prepareWrite(this, length);
    this.bytes.set(bytes.subarray(start, end), this.position);

    this.position += length;
    this.length = Math.max(this.length, this.position);
  };

  // ByteArray#writeByte(value:int):void
  this.writeByte = function(byte) {
    prepareWrite(this, 1);
    this.bytes[this.position] = byte;
    this.position++;
    this.length = Math.max(this.length, this.position);
  };

  // ByteArray#writeShort(value:int):void
  this.writeShort = function(short) {
    prepareWrite(this, 2);
    this.view.setUint16(this.position, short);
    this.position += 2;
    this.length = Math.max(this.length, this.position);
  };

  // Negative index into array
  // (pos:uint):int
  this.negIndex = function(pos) {
    return this.bytes[this.length - pos];
  };

  // The functions below ONLY work when this[0] == VIDEO_TAG.
  // We are not going to check for that because we dont want the overhead
  // (nal:ByteArray = null):int
  this.nalUnitSize = function() {
    if (adHoc === 0) {
      return 0;
    }

    return this.length - (adHoc + 4);
  };

  this.startNalUnit = function() {
    // remember position and add 4 bytes
    if (adHoc > 0) {
      throw new Error("Attempted to create new NAL wihout closing the old one");
    }

    // reserve 4 bytes for nal unit size
    adHoc = this.length;
    this.length += 4;
    this.position = this.length;
  };

  // (nal:ByteArray = null):void
  this.endNalUnit = function(nalContainer) {
    var
      nalStart, // :uint
      nalLength; // :uint

    // Rewind to the marker and write the size
    if (this.length === adHoc + 4) {
      // we started a nal unit, but didnt write one, so roll back the 4 byte size value
      this.length -= 4;
    } else if (adHoc > 0) {
      nalStart = adHoc + 4;
      nalLength = this.length - nalStart;

      this.position = adHoc;
      this.view.setUint32(this.position, nalLength);
      this.position = this.length;

      if (nalContainer) {
        // Add the tag to the NAL unit
        nalContainer.push(this.bytes.subarray(nalStart, nalStart + nalLength));
      }
    }

    adHoc = 0;
  };

  /**
   * Write out a 64-bit floating point valued metadata property. This method is
   * called frequently during a typical parse and needs to be fast.
   */
  // (key:String, val:Number):void
  this.writeMetaDataDouble = function(key, val) {
    var i;
    prepareWrite(this, 2 + key.length + 9);

    // write size of property name
    this.view.setUint16(this.position, key.length);
    this.position += 2;

    // this next part looks terrible but it improves parser throughput by
    // 10kB/s in my testing

    // write property name
    if (key === 'width') {
      this.bytes.set(widthBytes, this.position);
      this.position += 5;
    } else if (key === 'height') {
      this.bytes.set(heightBytes, this.position);
      this.position += 6;
    } else if (key === 'videocodecid') {
      this.bytes.set(videocodecidBytes, this.position);
      this.position += 12;
    } else {
      for (i = 0; i < key.length; i++) {
        this.bytes[this.position] = key.charCodeAt(i);
        this.position++;
      }
    }

    // skip null byte
    this.position++;

    // write property value
    this.view.setFloat64(this.position, val);
    this.position += 8;

    // update flv tag length
    this.length = Math.max(this.length, this.position);
    ++adHoc;
  };

  // (key:String, val:Boolean):void
  this.writeMetaDataBoolean = function(key, val) {
    var i;
    prepareWrite(this, 2);
    this.view.setUint16(this.position, key.length);
    this.position += 2;
    for (i = 0; i < key.length; i++) {
      // if key.charCodeAt(i) >= 255, handle error
      prepareWrite(this, 1);
      this.bytes[this.position] = key.charCodeAt(i);
      this.position++;
    }
    prepareWrite(this, 2);
    this.view.setUint8(this.position, 0x01);
    this.position++;
    this.view.setUint8(this.position, val ? 0x01 : 0x00);
    this.position++;
    this.length = Math.max(this.length, this.position);
    ++adHoc;
  };

  // ():ByteArray
  this.finalize = function() {
    var
      dtsDelta, // :int
      len; // :int

    switch(this.bytes[0]) {
      // Video Data
    case FlvTag.VIDEO_TAG:
      this.bytes[11] = ((this.keyFrame || extraData) ? 0x10 : 0x20 ) | 0x07; // We only support AVC, 1 = key frame (for AVC, a seekable frame), 2 = inter frame (for AVC, a non-seekable frame)
      this.bytes[12] = extraData ?  0x00 : 0x01;

      dtsDelta = this.pts - this.dts;
      this.bytes[13] = (dtsDelta & 0x00FF0000) >>> 16;
      this.bytes[14] = (dtsDelta & 0x0000FF00) >>>  8;
      this.bytes[15] = (dtsDelta & 0x000000FF) >>>  0;
      break;

    case FlvTag.AUDIO_TAG:
      this.bytes[11] = 0xAF; // 44 kHz, 16-bit stereo
      this.bytes[12] = extraData ? 0x00 : 0x01;
      break;

    case FlvTag.METADATA_TAG:
      this.position = 11;
      this.view.setUint8(this.position, 0x02); // String type
      this.position++;
      this.view.setUint16(this.position, 0x0A); // 10 Bytes
      this.position += 2;
      // set "onMetaData"
      this.bytes.set([0x6f, 0x6e, 0x4d, 0x65,
                      0x74, 0x61, 0x44, 0x61,
                      0x74, 0x61], this.position);
      this.position += 10;
      this.bytes[this.position] = 0x08; // Array type
      this.position++;
      this.view.setUint32(this.position, adHoc);
      this.position = this.length;
      this.bytes.set([0, 0, 9], this.position);
      this.position += 3; // End Data Tag
      this.length = this.position;
      break;
    }

    len = this.length - 11;

    // write the DataSize field
    this.bytes[ 1] = (len & 0x00FF0000) >>> 16;
    this.bytes[ 2] = (len & 0x0000FF00) >>>  8;
    this.bytes[ 3] = (len & 0x000000FF) >>>  0;
    // write the Timestamp
    this.bytes[ 4] = (this.dts & 0x00FF0000) >>> 16;
    this.bytes[ 5] = (this.dts & 0x0000FF00) >>>  8;
    this.bytes[ 6] = (this.dts & 0x000000FF) >>>  0;
    this.bytes[ 7] = (this.dts & 0xFF000000) >>> 24;
    // write the StreamID
    this.bytes[ 8] = 0;
    this.bytes[ 9] = 0;
    this.bytes[10] = 0;

    // Sometimes we're at the end of the view and have one slot to write a
    // uint32, so, prepareWrite of count 4, since, view is uint8
    prepareWrite(this, 4);
    this.view.setUint32(this.length, this.length);
    this.length += 4;
    this.position += 4;

    // trim down the byte buffer to what is actually being used
    this.bytes = this.bytes.subarray(0, this.length);
    this.frameTime = FlvTag.frameTime(this.bytes);
    // if bytes.bytelength isn't equal to this.length, handle error
    return this;
  };
};

FlvTag.AUDIO_TAG = 0x08; // == 8, :uint
FlvTag.VIDEO_TAG = 0x09; // == 9, :uint
FlvTag.METADATA_TAG = 0x12; // == 18, :uint

// (tag:ByteArray):Boolean {
FlvTag.isAudioFrame = function(tag) {
  return FlvTag.AUDIO_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
FlvTag.isVideoFrame = function(tag) {
  return FlvTag.VIDEO_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
FlvTag.isMetaData = function(tag) {
  return FlvTag.METADATA_TAG === tag[0];
};

// (tag:ByteArray):Boolean {
FlvTag.isKeyFrame = function(tag) {
  if (FlvTag.isVideoFrame(tag)) {
    return tag[11] === 0x17;
  }

  if (FlvTag.isAudioFrame(tag)) {
    return true;
  }

  if (FlvTag.isMetaData(tag)) {
    return true;
  }

  return false;
};

// (tag:ByteArray):uint {
FlvTag.frameTime = function(tag) {
  var pts = tag[ 4] << 16; // :uint
  pts |= tag[ 5] <<  8;
  pts |= tag[ 6] <<  0;
  pts |= tag[ 7] << 24;
  return pts;
};

module.exports = FlvTag;

},{}],6:[function(require,module,exports){
module.exports = {
  tag: require('./flv-tag'),
  Transmuxer: require('./transmuxer'),
  tools: require('../tools/flv-inspector'),
};

},{"../tools/flv-inspector":17,"./flv-tag":5,"./transmuxer":7}],7:[function(require,module,exports){
'use strict';

var Stream = require('../utils/stream.js');
var FlvTag = require('./flv-tag.js');
var m2ts = require('../m2ts/m2ts.js');
var AdtsStream = require('../codecs/adts.js');
var H264Stream = require('../codecs/h264').H264Stream;

var
  MetadataStream,
  Transmuxer,
  VideoSegmentStream,
  AudioSegmentStream,
  CoalesceStream,
  collectTimelineInfo,
  metaDataTag,
  extraDataTag;

/**
 * Store information about the start and end of the tracka and the
 * duration for each frame/sample we process in order to calculate
 * the baseMediaDecodeTime
 */
collectTimelineInfo = function (track, data) {
  if (typeof data.pts === 'number') {
    if (track.timelineStartInfo.pts === undefined) {
      track.timelineStartInfo.pts = data.pts;
    } else {
      track.timelineStartInfo.pts =
        Math.min(track.timelineStartInfo.pts, data.pts);
    }
  }

  if (typeof data.dts === 'number') {
    if (track.timelineStartInfo.dts === undefined) {
      track.timelineStartInfo.dts = data.dts;
    } else {
      track.timelineStartInfo.dts =
        Math.min(track.timelineStartInfo.dts, data.dts);
    }
  }
};

metaDataTag = function(track, pts) {
  var
    tag = new FlvTag(FlvTag.METADATA_TAG); // :FlvTag

  tag.dts = pts;
  tag.pts = pts;

  tag.writeMetaDataDouble("videocodecid", 7);
  tag.writeMetaDataDouble("width", track.width);
  tag.writeMetaDataDouble("height", track.height);

  return tag;
};

extraDataTag = function(track, pts) {
  var
    i,
    tag = new FlvTag(FlvTag.VIDEO_TAG, true);

  tag.dts = pts;
  tag.pts = pts;

  tag.writeByte(0x01);// version
  tag.writeByte(track.profileIdc);// profile
  tag.writeByte(track.profileCompatibility);// compatibility
  tag.writeByte(track.levelIdc);// level
  tag.writeByte(0xFC | 0x03); // reserved (6 bits), NULA length size - 1 (2 bits)
  tag.writeByte(0xE0 | 0x01 ); // reserved (3 bits), num of SPS (5 bits)
  tag.writeShort( track.sps[0].length ); // data of SPS
  tag.writeBytes( track.sps[0] ); // SPS

  tag.writeByte(track.pps.length); // num of PPS (will there ever be more that 1 PPS?)
  for (i = 0 ; i < track.pps.length ; ++i) {
    tag.writeShort(track.pps[i].length); // 2 bytes for length of PPS
    tag.writeBytes(track.pps[i]); // data of PPS
  }

  return tag;
};

/**
 * Constructs a single-track, media segment from AAC data
 * events. The output of this stream can be fed to flash.
 */
AudioSegmentStream = function(track) {
  var
    adtsFrames = [],
    adtsFramesLength = 0,
    sequenceNumber = 0,
    earliestAllowedDts = 0,
    oldExtraData;

  AudioSegmentStream.prototype.init.call(this);

  this.push = function(data) {
    collectTimelineInfo(track, data);

    if (track && track.channelcount === undefined) {
      track.audioobjecttype = data.audioobjecttype;
      track.channelcount = data.channelcount;
      track.samplerate = data.samplerate;
      track.samplingfrequencyindex = data.samplingfrequencyindex;
      track.samplesize = data.samplesize;
      track.extraData = (track.audioobjecttype << 11) |
                        (track.samplingfrequencyindex << 7) |
                        (track.channelcount << 3);
    }

    data.pts = Math.round(data.pts / 90);
    data.dts = Math.round(data.dts / 90);

    // buffer audio data until end() is called
    adtsFrames.push(data);
  };

  this.flush = function() {
    var currentFrame, adtsFrame, deltaDts,lastMetaPts, tags = [];
    // return early if no audio data has been observed
    if (adtsFrames.length === 0) {
      this.trigger('done');
      return;
    }

    lastMetaPts = -Infinity;

    while (adtsFrames.length) {
      currentFrame = adtsFrames.shift();

      // write out metadata tags every 1 second so that the decoder
      // is re-initialized quickly after seeking into a different
      // audio configuration
      if (track.extraData !== oldExtraData || currentFrame.pts - lastMetaPts >= 1000) {
       adtsFrame = new FlvTag(FlvTag.METADATA_TAG);
        adtsFrame.pts = currentFrame.pts;
        adtsFrame.dts = currentFrame.dts;

        // AAC is always 10
        adtsFrame.writeMetaDataDouble("audiocodecid", 10);
        adtsFrame.writeMetaDataBoolean("stereo", 2 === track.channelcount);
        adtsFrame.writeMetaDataDouble ("audiosamplerate", track.samplerate);
        // Is AAC always 16 bit?
        adtsFrame.writeMetaDataDouble ("audiosamplesize", 16);

        tags.push(adtsFrame);

        oldExtraData = track.extraData;

        adtsFrame = new FlvTag(FlvTag.AUDIO_TAG, true);
        // For audio, DTS is always the same as PTS. We want to set the DTS
        // however so we can compare with video DTS to determine approximate
        // packet order
        adtsFrame.pts = currentFrame.pts;
        adtsFrame.dts = currentFrame.dts;

        adtsFrame.view.setUint16(adtsFrame.position, track.extraData);
        adtsFrame.position += 2;
        adtsFrame.length = Math.max(adtsFrame.length, adtsFrame.position);

        tags.push(adtsFrame);

        lastMetaPts = currentFrame.pts;
      }
      adtsFrame = new FlvTag(FlvTag.AUDIO_TAG);
      adtsFrame.pts = currentFrame.pts;
      adtsFrame.dts = currentFrame.dts;

      adtsFrame.writeBytes(currentFrame.data);

      tags.push(adtsFrame);
    }

    oldExtraData = null;
    this.trigger('data', {track: track, tags: tags});

    this.trigger('done');
  };
};
AudioSegmentStream.prototype = new Stream();

/**
 * Store FlvTags for the h264 stream
 * @param track {object} track metadata configuration
 */
VideoSegmentStream = function(track) {
  var
    sequenceNumber = 0,
    nalUnits = [],
    nalUnitsLength = 0,
    config,
    h264Frame;
  VideoSegmentStream.prototype.init.call(this);

  this.finishFrame = function(tags, frame) {
    if (!frame) {
      return;
    }
    // Check if keyframe and the length of tags.
    // This makes sure we write metadata on the first frame of a segment.
    if (config && track && track.newMetadata &&
        (frame.keyFrame || tags.length === 0)) {
      // Push extra data on every IDR frame in case we did a stream change + seek
      tags.push(metaDataTag(config, frame.pts));
      tags.push(extraDataTag(track, frame.pts));
      track.newMetadata = false;
    }

    frame.endNalUnit();
    tags.push(frame);
  };

  this.push = function(data) {
    collectTimelineInfo(track, data);

    data.pts = Math.round(data.pts / 90);
    data.dts = Math.round(data.dts / 90);

    // buffer video until flush() is called
    nalUnits.push(data);
  };

  this.flush = function() {
    var
      currentNal,
      tags = [];

    // Throw away nalUnits at the start of the byte stream until we find
    // the first AUD
    while (nalUnits.length) {
      if (nalUnits[0].nalUnitType === 'access_unit_delimiter_rbsp') {
        break;
      }
      nalUnits.shift();
    }

    // return early if no video data has been observed
    if (nalUnits.length === 0) {
      this.trigger('done');
      return;
    }

    while (nalUnits.length) {
      currentNal = nalUnits.shift();

      // record the track config
      if (currentNal.nalUnitType === 'seq_parameter_set_rbsp') {
        track.newMetadata = true;
        config = currentNal.config;
        track.width = config.width;
        track.height = config.height;
        track.sps = [currentNal.data];
        track.profileIdc = config.profileIdc;
        track.levelIdc = config.levelIdc;
        track.profileCompatibility = config.profileCompatibility;
        h264Frame.endNalUnit();
      } else if (currentNal.nalUnitType === 'pic_parameter_set_rbsp') {
        track.newMetadata = true;
        track.pps = [currentNal.data];
        h264Frame.endNalUnit();
      } else if (currentNal.nalUnitType === 'access_unit_delimiter_rbsp') {
        if (h264Frame) {
          this.finishFrame(tags, h264Frame);
        }
        h264Frame = new FlvTag(FlvTag.VIDEO_TAG);
        h264Frame.pts = currentNal.pts;
        h264Frame.dts = currentNal.dts;
      } else {
        if (currentNal.nalUnitType === 'slice_layer_without_partitioning_rbsp_idr') {
          // the current sample is a key frame
          h264Frame.keyFrame = true;
        }
        h264Frame.endNalUnit();
      }
      h264Frame.startNalUnit();
      h264Frame.writeBytes(currentNal.data);
    }
    if (h264Frame) {
      this.finishFrame(tags, h264Frame);
    }

    this.trigger('data', {track: track, tags: tags});

    // Continue with the flush process now
    this.trigger('done');
  };
};

VideoSegmentStream.prototype = new Stream();

/**
 * The final stage of the transmuxer that emits the flv tags
 * for audio, video, and metadata. Also tranlates in time and
 * outputs caption data and id3 cues.
 */
CoalesceStream = function(options) {
  // Number of Tracks per output segment
  // If greater than 1, we combine multiple
  // tracks into a single segment
  this.numberOfTracks = 0;
  this.metadataStream = options.metadataStream;

  this.videoTags = [];
  this.audioTags = [];
  this.videoTrack = null;
  this.audioTrack = null;
  this.pendingCaptions = [];
  this.pendingMetadata = [];
  this.pendingTracks = 0;

  CoalesceStream.prototype.init.call(this);

  // Take output from multiple
  this.push = function(output) {
    // buffer incoming captions until the associated video segment
    // finishes
    if (output.text) {
      return this.pendingCaptions.push(output);
    }
    // buffer incoming id3 tags until the final flush
    if (output.frames) {
      return this.pendingMetadata.push(output);
    }

    if (output.track.type === 'video') {
      this.videoTrack = output.track;
      this.videoTags = output.tags;
      this.pendingTracks++;
    }
    if (output.track.type === 'audio') {
      this.audioTrack = output.track;
      this.audioTags = output.tags;
      this.pendingTracks++;
    }
  };
};

CoalesceStream.prototype = new Stream();
CoalesceStream.prototype.flush = function() {
  var
    id3,
    caption,
    i,
    timelineStartPts,
    event = {
      tags: {},
      captions: [],
      metadata: []
    };

  if (this.pendingTracks < this.numberOfTracks) {
    return;
  }

  if (this.videoTrack) {
    timelineStartPts = this.videoTrack.timelineStartInfo.pts;
  } else if (this.audioTrack) {
    timelineStartPts = this.audioTrack.timelineStartInfo.pts;
  }

  event.tags.videoTags = this.videoTags;
  event.tags.audioTags = this.audioTags;

  // Translate caption PTS times into second offsets into the
  // video timeline for the segment
  for (i = 0; i < this.pendingCaptions.length; i++) {
    caption = this.pendingCaptions[i];
    caption.startTime = caption.startPts - timelineStartPts;
    caption.startTime /= 90e3;
    caption.endTime = caption.endPts - timelineStartPts;
    caption.endTime /= 90e3;
    event.captions.push(caption);
  }

  // Translate ID3 frame PTS times into second offsets into the
  // video timeline for the segment
  for (i = 0; i < this.pendingMetadata.length; i++) {
    id3 = this.pendingMetadata[i];
    id3.cueTime = id3.pts - timelineStartPts;
    id3.cueTime /= 90e3;
    event.metadata.push(id3);
  }
  // We add this to every single emitted segment even though we only need
  // it for the first
  event.metadata.dispatchType = this.metadataStream.dispatchType;

  // Reset stream state
  this.videoTrack = null;
  this.audioTrack = null;
  this.videoTags = [];
  this.audioTags = [];
  this.pendingCaptions.length = 0;
  this.pendingMetadata.length = 0;
  this.pendingTracks = 0;

  // Emit the final segment
  this.trigger('data', event);

  this.trigger('done');
};

/**
 * An object that incrementally transmuxes MPEG2 Trasport Stream
 * chunks into an FLV.
 */
Transmuxer = function(options) {
  var
    self = this,
    videoTrack,
    audioTrack,

    packetStream, parseStream, elementaryStream,
    adtsStream, h264Stream,
    videoSegmentStream, audioSegmentStream, captionStream,
    coalesceStream;

  Transmuxer.prototype.init.call(this);

  options = options || {};

  // expose the metadata stream
  this.metadataStream = new m2ts.MetadataStream();

  options.metadataStream = this.metadataStream;

  // set up the parsing pipeline
  packetStream = new m2ts.TransportPacketStream();
  parseStream = new m2ts.TransportParseStream();
  elementaryStream = new m2ts.ElementaryStream();
  adtsStream = new AdtsStream();
  h264Stream = new H264Stream();
  coalesceStream = new CoalesceStream(options);

  // disassemble MPEG2-TS packets into elementary streams
  packetStream
    .pipe(parseStream)
    .pipe(elementaryStream);

  // !!THIS ORDER IS IMPORTANT!!
  // demux the streams
  elementaryStream
    .pipe(h264Stream);
  elementaryStream
    .pipe(adtsStream);

  elementaryStream
    .pipe(this.metadataStream)
    .pipe(coalesceStream);
  // if CEA-708 parsing is available, hook up a caption stream
  captionStream = new m2ts.CaptionStream();
  h264Stream.pipe(captionStream)
    .pipe(coalesceStream);

  // hook up the segment streams once track metadata is delivered
  elementaryStream.on('data', function(data) {
    var i, videoTrack, audioTrack;

    if (data.type === 'metadata') {
      i = data.tracks.length;

      // scan the tracks listed in the metadata
      while (i--) {
        if (data.tracks[i].type === 'video') {
          videoTrack = data.tracks[i];
        } else if (data.tracks[i].type === 'audio') {
          audioTrack = data.tracks[i];
        }
      }

      // hook up the video segment stream to the first track with h264 data
      if (videoTrack && !videoSegmentStream) {
        coalesceStream.numberOfTracks++;
        videoSegmentStream = new VideoSegmentStream(videoTrack);

        // Set up the final part of the video pipeline
        h264Stream
          .pipe(videoSegmentStream)
          .pipe(coalesceStream);
      }

      if (audioTrack && !audioSegmentStream) {
        // hook up the audio segment stream to the first track with aac data
        coalesceStream.numberOfTracks++;
        audioSegmentStream = new AudioSegmentStream(audioTrack);

        // Set up the final part of the audio pipeline
        adtsStream
          .pipe(audioSegmentStream)
          .pipe(coalesceStream);
      }
    }
  });

  // feed incoming data to the front of the parsing pipeline
  this.push = function(data) {
    packetStream.push(data);
  };

  // flush any buffered data
  this.flush = function() {
    // Start at the top of the pipeline and flush all pending work
    packetStream.flush();
  };

  // Re-emit any data coming from the coalesce stream to the outside world
  coalesceStream.on('data', function (event) {
    self.trigger('data', event);
  });

  // Let the consumer know we have finished flushing the entire pipeline
  coalesceStream.on('done', function () {
    self.trigger('done');
  });

  // For information on the FLV format, see
  // http://download.macromedia.com/f4v/video_file_format_spec_v10_1.pdf.
  // Technically, this function returns the header and a metadata FLV tag
  // if duration is greater than zero
  // duration in seconds
  // @return {object} the bytes of the FLV header as a Uint8Array
  this.getFlvHeader = function(duration, audio, video) { // :ByteArray {
    var
      headBytes = new Uint8Array(3 + 1 + 1 + 4),
      head = new DataView(headBytes.buffer),
      metadata,
      result,
      metadataLength;

    // default arguments
    duration = duration || 0;
    audio = audio === undefined? true : audio;
    video = video === undefined? true : video;

    // signature
    head.setUint8(0, 0x46); // 'F'
    head.setUint8(1, 0x4c); // 'L'
    head.setUint8(2, 0x56); // 'V'

    // version
    head.setUint8(3, 0x01);

    // flags
    head.setUint8(4, (audio ? 0x04 : 0x00) | (video ? 0x01 : 0x00));

    // data offset, should be 9 for FLV v1
    head.setUint32(5, headBytes.byteLength);

    // init the first FLV tag
    if (duration <= 0) {
      // no duration available so just write the first field of the first
      // FLV tag
      result = new Uint8Array(headBytes.byteLength + 4);
      result.set(headBytes);
      result.set([0, 0, 0, 0], headBytes.byteLength);
      return result;
    }

    // write out the duration metadata tag
    metadata = new FlvTag(FlvTag.METADATA_TAG);
    metadata.pts = metadata.dts = 0;
    metadata.writeMetaDataDouble("duration", duration);
    metadataLength = metadata.finalize().length;
    result = new Uint8Array(headBytes.byteLength + metadataLength);
    result.set(headBytes);
    result.set(head.byteLength, metadataLength);

    return result;
  };
};
Transmuxer.prototype = new Stream();

// forward compatibility
module.exports = Transmuxer;

},{"../codecs/adts.js":2,"../codecs/h264":3,"../m2ts/m2ts.js":11,"../utils/stream.js":20,"./flv-tag.js":5}],8:[function(require,module,exports){
'use strict';

var muxjs = {
  codecs: require('./codecs'),
  mp4: require('./mp4'),
  flv: require('./flv'),
  mp2t: require('./m2ts'),
};
module.exports = muxjs;

},{"./codecs":4,"./flv":6,"./m2ts":10,"./mp4":14}],9:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Reads in-band caption information from a video elementary
 * stream. Captions must follow the CEA-708 standard for injection
 * into an MPEG-2 transport streams.
 * @see https://en.wikipedia.org/wiki/CEA-708
 */

'use strict';

// -----------------
// Link To Transport
// -----------------

// Supplemental enhancement information (SEI) NAL units have a
// payload type field to indicate how they are to be
// interpreted. CEAS-708 caption content is always transmitted with
// payload type 0x04.
var USER_DATA_REGISTERED_ITU_T_T35 = 4,
    RBSP_TRAILING_BITS = 128,
    Stream = require('../utils/stream');

/**
  * Parse a supplemental enhancement information (SEI) NAL unit.
  * Stops parsing once a message of type ITU T T35 has been found.
  *
  * @param bytes {Uint8Array} the bytes of a SEI NAL unit
  * @return {object} the parsed SEI payload
  * @see Rec. ITU-T H.264, 7.3.2.3.1
  */
var parseSei = function(bytes) {
  var
    i = 0,
    result = {
      payloadType: -1,
      payloadSize: 0,
    },
    payloadType = 0,
    payloadSize = 0;

  // go through the sei_rbsp parsing each each individual sei_message
  while (i < bytes.byteLength) {
    // stop once we have hit the end of the sei_rbsp
    if (bytes[i] === RBSP_TRAILING_BITS) {
      break;
    }

    // Parse payload type
    while (bytes[i] === 0xFF) {
      payloadType += 255;
      i++;
    }
    payloadType += bytes[i++];

    // Parse payload size
    while (bytes[i] === 0xFF) {
      payloadSize += 255;
      i++;
    }
    payloadSize += bytes[i++];

    // this sei_message is a 608/708 caption so save it and break
    // there can only ever be one caption message in a frame's sei
    if (!result.payload && payloadType === USER_DATA_REGISTERED_ITU_T_T35) {
      result.payloadType = payloadType;
      result.payloadSize = payloadSize;
      result.payload = bytes.subarray(i, i + payloadSize);
      break;
    }

    // skip the payload and parse the next message
    i += payloadSize;
    payloadType = 0;
    payloadSize = 0;
  }

  return result;
};

// see ANSI/SCTE 128-1 (2013), section 8.1
var parseUserData = function(sei) {
  // itu_t_t35_contry_code must be 181 (United States) for
  // captions
  if (sei.payload[0] !== 181) {
    return null;
  }

  // itu_t_t35_provider_code should be 49 (ATSC) for captions
  if (((sei.payload[1] << 8) | sei.payload[2]) !== 49) {
    return null;
  }

  // the user_identifier should be "GA94" to indicate ATSC1 data
  if (String.fromCharCode(sei.payload[3],
                          sei.payload[4],
                          sei.payload[5],
                          sei.payload[6]) !== 'GA94') {
    return null;
  }

  // finally, user_data_type_code should be 0x03 for caption data
  if (sei.payload[7] !== 0x03) {
    return null;
  }

  // return the user_data_type_structure and strip the trailing
  // marker bits
  return sei.payload.subarray(8, sei.payload.length - 1);
};

// see CEA-708-D, section 4.4
var parseCaptionPackets = function(pts, userData) {
  var results = [], i, count, offset, data;

  // if this is just filler, return immediately
  if (!(userData[0] & 0x40)) {
    return results;
  }

  // parse out the cc_data_1 and cc_data_2 fields
  count = userData[0] & 0x1f;
  for (i = 0; i < count; i++) {
    offset = i * 3;
    data = {
      type: userData[offset + 2] & 0x03,
      pts: pts
    };

    // capture cc data when cc_valid is 1
    if (userData[offset + 2] & 0x04) {
      data.ccData = (userData[offset + 3] << 8) | userData[offset + 4];
      results.push(data);
    }
  }
  return results;
};

var CaptionStream = function() {
  var self = this;
  CaptionStream.prototype.init.call(this);

  this.captionPackets_ = [];

  this.field1_ = new Cea608Stream();

  // forward data and done events from field1_ to this CaptionStream
  this.field1_.on('data', this.trigger.bind(this, 'data'));
  this.field1_.on('done', this.trigger.bind(this, 'done'));
};
CaptionStream.prototype = new Stream();
CaptionStream.prototype.push = function(event) {
  var sei, userData, captionPackets;

  // only examine SEI NALs
  if (event.nalUnitType !== 'sei_rbsp') {
    return;
  }

  // parse the sei
  sei = parseSei(event.escapedRBSP);

  // ignore everything but user_data_registered_itu_t_t35
  if (sei.payloadType !== USER_DATA_REGISTERED_ITU_T_T35) {
    return;
  }

  // parse out the user data payload
  userData = parseUserData(sei);

  // ignore unrecognized userData
  if (!userData) {
    return;
  }

  // parse out CC data packets and save them for later
  this.captionPackets_ = this.captionPackets_.concat(parseCaptionPackets(event.pts, userData));
};

CaptionStream.prototype.flush = function () {
  // make sure we actually parsed captions before proceeding
  if (!this.captionPackets_.length) {
    this.field1_.flush();
    return;
  }

  // sort caption byte-pairs based on their PTS values
  this.captionPackets_.sort(function(a, b) {
    return a.pts - b.pts;
  });

  // Push each caption into Cea608Stream
  this.captionPackets_.forEach(this.field1_.push, this.field1_);

  this.captionPackets_.length = 0;
  this.field1_.flush();
  return;
};
// ----------------------
// Session to Application
// ----------------------

var BASIC_CHARACTER_TRANSLATION = {
  0x2a: 0xe1,
  0x5c: 0xe9,
  0x5e: 0xed,
  0x5f: 0xf3,
  0x60: 0xfa,
  0x7b: 0xe7,
  0x7c: 0xf7,
  0x7d: 0xd1,
  0x7e: 0xf1,
  0x7f: 0x2588
};

var getCharFromCode = function(code) {
  if(code === null) {
    return '';
  }
  code = BASIC_CHARACTER_TRANSLATION[code] || code;
  return String.fromCharCode(code);
};

// Constants for the byte codes recognized by Cea608Stream. This
// list is not exhaustive. For a more comprehensive listing and
// semantics see
// http://www.gpo.gov/fdsys/pkg/CFR-2010-title47-vol1/pdf/CFR-2010-title47-vol1-sec15-119.pdf
var PADDING                    = 0x0000,

    // Pop-on Mode
    RESUME_CAPTION_LOADING     = 0x1420,
    END_OF_CAPTION             = 0x142f,

    // Roll-up Mode
    ROLL_UP_2_ROWS             = 0x1425,
    ROLL_UP_3_ROWS             = 0x1426,
    ROLL_UP_4_ROWS             = 0x1427,
    RESUME_DIRECT_CAPTIONING   = 0x1429,
    CARRIAGE_RETURN            = 0x142d,
    // Erasure
    BACKSPACE                  = 0x1421,
    ERASE_DISPLAYED_MEMORY     = 0x142c,
    ERASE_NON_DISPLAYED_MEMORY = 0x142e;

// the index of the last row in a CEA-608 display buffer
var BOTTOM_ROW = 14;
// CEA-608 captions are rendered onto a 34x15 matrix of character
// cells. The "bottom" row is the last element in the outer array.
var createDisplayBuffer = function() {
  var result = [], i = BOTTOM_ROW + 1;
  while (i--) {
    result.push('');
  }
  return result;
};

var Cea608Stream = function() {
  Cea608Stream.prototype.init.call(this);

  this.mode_ = 'popOn';
  // When in roll-up mode, the index of the last row that will
  // actually display captions. If a caption is shifted to a row
  // with a lower index than this, it is cleared from the display
  // buffer
  this.topRow_ = 0;
  this.startPts_ = 0;
  this.displayed_ = createDisplayBuffer();
  this.nonDisplayed_ = createDisplayBuffer();
  this.lastControlCode_ = null;

  this.push = function(packet) {
    // Ignore other channels
    if (packet.type !== 0) {
      return;
    }
    var data, swap, char0, char1;
    // remove the parity bits
    data = packet.ccData & 0x7f7f;

    // ignore duplicate control codes
    if (data === this.lastControlCode_) {
      this.lastControlCode_ = null;
      return;
    }

    // Store control codes
    if ((data & 0xf000) === 0x1000) {
      this.lastControlCode_ = data;
    } else {
      this.lastControlCode_ = null;
    }

    switch (data) {
    case PADDING:
      break;
    case RESUME_CAPTION_LOADING:
      this.mode_ = 'popOn';
      break;
    case END_OF_CAPTION:
      // if a caption was being displayed, it's gone now
      this.flushDisplayed(packet.pts);

      // flip memory
      swap = this.displayed_;
      this.displayed_ = this.nonDisplayed_;
      this.nonDisplayed_ = swap;

      // start measuring the time to display the caption
      this.startPts_ = packet.pts;
      break;

    case ROLL_UP_2_ROWS:
      this.topRow_ = BOTTOM_ROW - 1;
      this.mode_ = 'rollUp';
      break;
    case ROLL_UP_3_ROWS:
      this.topRow_ = BOTTOM_ROW - 2;
      this.mode_ = 'rollUp';
      break;
    case ROLL_UP_4_ROWS:
      this.topRow_ = BOTTOM_ROW - 3;
      this.mode_ = 'rollUp';
      break;
    case CARRIAGE_RETURN:
      this.flushDisplayed(packet.pts);
      this.shiftRowsUp_();
      this.startPts_ = packet.pts;
      break;

    case BACKSPACE:
      if (this.mode_ === 'popOn') {
        this.nonDisplayed_[BOTTOM_ROW] = this.nonDisplayed_[BOTTOM_ROW].slice(0, -1);
      } else {
        this.displayed_[BOTTOM_ROW] = this.displayed_[BOTTOM_ROW].slice(0, -1);
      }
      break;
    case ERASE_DISPLAYED_MEMORY:
      this.flushDisplayed(packet.pts);
      this.displayed_ = createDisplayBuffer();
      break;
    case ERASE_NON_DISPLAYED_MEMORY:
      this.nonDisplayed_ = createDisplayBuffer();
      break;
    default:
      char0 = data >>> 8;
      char1 = data & 0xff;

      // Look for a Channel 1 Preamble Address Code
      if (char0 >= 0x10 && char0 <= 0x17 &&
          char1 >= 0x40 && char1 <= 0x7F &&
          (char0 !== 0x10 || char1 < 0x60)) {
        // Follow Safari's lead and replace the PAC with a space
        char0 = 0x20;
        // we only want one space so make the second character null
        // which will get become '' in getCharFromCode
        char1 = null;
      }

      // Look for special character sets
      if ((char0 === 0x11 || char0 === 0x19) &&
          (char1 >= 0x30 && char1 <= 0x3F)) {
        // Put in eigth note and space
        char0 = 0x266A;
        char1 = '';
      }

      // ignore unsupported control codes
      if ((char0 & 0xf0) === 0x10) {
        return;
      }

      // character handling is dependent on the current mode
      this[this.mode_](packet.pts, char0, char1);
      break;
    }
  };
};
Cea608Stream.prototype = new Stream();
// Trigger a cue point that captures the current state of the
// display buffer
Cea608Stream.prototype.flushDisplayed = function(pts) {
  var content = this.displayed_
    // remove spaces from the start and end of the string
    .map(function(row) { return row.trim(); })
    // remove empty rows
    .filter(function(row) { return row.length; })
    // combine all text rows to display in one cue
    .join('\n');

  if (content.length) {
    this.trigger('data', {
      startPts: this.startPts_,
      endPts: pts,
      text: content
    });
  }
};

// Mode Implementations
Cea608Stream.prototype.popOn = function(pts, char0, char1) {
  var baseRow = this.nonDisplayed_[BOTTOM_ROW];

  // buffer characters
  baseRow += getCharFromCode(char0);
  baseRow += getCharFromCode(char1);
  this.nonDisplayed_[BOTTOM_ROW] = baseRow;
};

Cea608Stream.prototype.rollUp = function(pts, char0, char1) {
  var baseRow = this.displayed_[BOTTOM_ROW];
  if (baseRow === '') {
    // we're starting to buffer new display input, so flush out the
    // current display
    this.flushDisplayed(pts);

    this.startPts_ = pts;
  }

  baseRow += getCharFromCode(char0);
  baseRow += getCharFromCode(char1);

  this.displayed_[BOTTOM_ROW] = baseRow;
};
Cea608Stream.prototype.shiftRowsUp_ = function() {
  var i;
  // clear out inactive rows
  for (i = 0; i < this.topRow_; i++) {
    this.displayed_[i] = '';
  }
  // shift displayed rows up
  for (i = this.topRow_; i < BOTTOM_ROW; i++) {
    this.displayed_[i] = this.displayed_[i + 1];
  }
  // clear out the bottom row
  this.displayed_[BOTTOM_ROW] = '';
};

// exports
module.exports = {
  CaptionStream: CaptionStream,
  Cea608Stream: Cea608Stream,
};


},{"../utils/stream":20}],10:[function(require,module,exports){
module.exports = require('./m2ts');

},{"./m2ts":11}],11:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * A stream-based mp2t to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */
'use strict';
var Stream = require('../utils/stream.js'),
  CaptionStream = require('./caption-stream'),
  StreamTypes = require('./stream-types');

var Stream = require('../utils/stream.js');
var m2tsStreamTypes = require('./stream-types.js');

// object types
var
  TransportPacketStream, TransportParseStream, ElementaryStream,
  AacStream, H264Stream, NalByteStream;

// constants
var
  MP2T_PACKET_LENGTH = 188, // bytes
  SYNC_BYTE = 0x47,

/**
 * Splits an incoming stream of binary data into MPEG-2 Transport
 * Stream packets.
 */
TransportPacketStream = function() {
  var
    buffer = new Uint8Array(MP2T_PACKET_LENGTH),
    bytesInBuffer = 0;

  TransportPacketStream.prototype.init.call(this);

   // Deliver new bytes to the stream.

  this.push = function(bytes) {
    var
      i = 0,
      startIndex = 0,
      endIndex = MP2T_PACKET_LENGTH,
      everything;

    // If there are bytes remaining from the last segment, prepend them to the
    // bytes that were pushed in
    if (bytesInBuffer) {
      everything = new Uint8Array(bytes.byteLength + bytesInBuffer);
      everything.set(buffer.subarray(0, bytesInBuffer));
      everything.set(bytes, bytesInBuffer);
      bytesInBuffer = 0;
    } else {
      everything = bytes;
    }

    // While we have enough data for a packet
    while (endIndex < everything.byteLength) {
      // Look for a pair of start and end sync bytes in the data..
      if (everything[startIndex] === SYNC_BYTE && everything[endIndex] === SYNC_BYTE) {
        // We found a packet so emit it and jump one whole packet forward in
        // the stream
        this.trigger('data', everything.subarray(startIndex, endIndex));
        startIndex += MP2T_PACKET_LENGTH;
        endIndex += MP2T_PACKET_LENGTH;
        continue;
      }
      // If we get here, we have somehow become de-synchronized and we need to step
      // forward one byte at a time until we find a pair of sync bytes that denote
      // a packet
      startIndex++;
      endIndex++;
    }

    // If there was some data left over at the end of the segment that couldn't
    // possibly be a whole packet, keep it because it might be the start of a packet
    // that continues in the next segment
    if (startIndex < everything.byteLength) {
      buffer.set(everything.subarray(startIndex), 0);
      bytesInBuffer = everything.byteLength - startIndex;
    }
  };

  this.flush = function () {
    // If the buffer contains a whole packet when we are being flushed, emit it
    // and empty the buffer. Otherwise hold onto the data because it may be
    // important for decoding the next segment
    if (bytesInBuffer === MP2T_PACKET_LENGTH && buffer[0] === SYNC_BYTE) {
      this.trigger('data', buffer);
      bytesInBuffer = 0;
    }
    this.trigger('done');
  };
};
TransportPacketStream.prototype = new Stream();

/**
 * Accepts an MP2T TransportPacketStream and emits data events with parsed
 * forms of the individual transport stream packets.
 */
TransportParseStream = function() {
  var parsePsi, parsePat, parsePmt, parsePes, self;
  TransportParseStream.prototype.init.call(this);
  self = this;

  this.packetsWaitingForPmt = [];
  this.programMapTable = undefined;

  parsePsi = function(payload, psi) {
    var offset = 0;

    // PSI packets may be split into multiple sections and those
    // sections may be split into multiple packets. If a PSI
    // section starts in this packet, the payload_unit_start_indicator
    // will be true and the first byte of the payload will indicate
    // the offset from the current position to the start of the
    // section.
    if (psi.payloadUnitStartIndicator) {
      offset += payload[offset] + 1;
    }

    if (psi.type === 'pat') {
      parsePat(payload.subarray(offset), psi);
    } else {
      parsePmt(payload.subarray(offset), psi);
    }
  };

  parsePat = function(payload, pat) {
    pat.section_number = payload[7];
    pat.last_section_number = payload[8];

    // skip the PSI header and parse the first PMT entry
    self.pmtPid = (payload[10] & 0x1F) << 8 | payload[11];
    pat.pmtPid = self.pmtPid;
  };

  /**
   * Parse out the relevant fields of a Program Map Table (PMT).
   * @param payload {Uint8Array} the PMT-specific portion of an MP2T
   * packet. The first byte in this array should be the table_id
   * field.
   * @param pmt {object} the object that should be decorated with
   * fields parsed from the PMT.
   */
  parsePmt = function(payload, pmt) {
    var sectionLength, tableEnd, programInfoLength, offset;

    // PMTs can be sent ahead of the time when they should actually
    // take effect. We don't believe this should ever be the case
    // for HLS but we'll ignore "forward" PMT declarations if we see
    // them. Future PMT declarations have the current_next_indicator
    // set to zero.
    if (!(payload[5] & 0x01)) {
      return;
    }

    // overwrite any existing program map table
    self.programMapTable = {};

    // the mapping table ends at the end of the current section
    sectionLength = (payload[1] & 0x0f) << 8 | payload[2];
    tableEnd = 3 + sectionLength - 4;

    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (payload[10] & 0x0f) << 8 | payload[11];

    // advance the offset to the first entry in the mapping table
    offset = 12 + programInfoLength;
    while (offset < tableEnd) {
      // add an entry that maps the elementary_pid to the stream_type
      self.programMapTable[(payload[offset + 1] & 0x1F) << 8 | payload[offset + 2]] = payload[offset];

      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((payload[offset + 3] & 0x0F) << 8 | payload[offset + 4]) + 5;
    }

    // record the map on the packet as well
    pmt.programMapTable = self.programMapTable;

    // if there are any packets waiting for a PMT to be found, process them now
    while (self.packetsWaitingForPmt.length) {
      self.processPes_.apply(self, self.packetsWaitingForPmt.shift());
    }
  };

  /**
   * Deliver a new MP2T packet to the stream.
   */
  this.push = function(packet) {
    var
      result = {},
      offset = 4;

    result.payloadUnitStartIndicator = !!(packet[1] & 0x40);

    // pid is a 13-bit field starting at the last bit of packet[1]
    result.pid = packet[1] & 0x1f;
    result.pid <<= 8;
    result.pid |= packet[2];

    // if an adaption field is present, its length is specified by the
    // fifth byte of the TS packet header. The adaptation field is
    // used to add stuffing to PES packets that don't fill a complete
    // TS packet, and to specify some forms of timing and control data
    // that we do not currently use.
    if (((packet[3] & 0x30) >>> 4) > 0x01) {
      offset += packet[offset] + 1;
    }

    // parse the rest of the packet based on the type
    if (result.pid === 0) {
      result.type = 'pat';
      parsePsi(packet.subarray(offset), result);
      this.trigger('data', result);
    } else if (result.pid === this.pmtPid) {
      result.type = 'pmt';
      parsePsi(packet.subarray(offset), result);
      this.trigger('data', result);
    } else if (this.programMapTable === undefined) {
      // When we have not seen a PMT yet, defer further processing of
      // PES packets until one has been parsed
      this.packetsWaitingForPmt.push([packet, offset, result]);
    } else {
      this.processPes_(packet, offset, result);
    }
  };

  this.processPes_ = function (packet, offset, result) {
    result.streamType = this.programMapTable[result.pid];
    result.type = 'pes';
    result.data = packet.subarray(offset);

    this.trigger('data', result);
  };

};
TransportParseStream.prototype = new Stream();
TransportParseStream.STREAM_TYPES  = {
  h264: 0x1b,
  adts: 0x0f
};

/**
 * Reconsistutes program elementary stream (PES) packets from parsed
 * transport stream packets. That is, if you pipe an
 * mp2t.TransportParseStream into a mp2t.ElementaryStream, the output
 * events will be events which capture the bytes for individual PES
 * packets plus relevant metadata that has been extracted from the
 * container.
 */
ElementaryStream = function() {
  var
    // PES packet fragments
    video = {
      data: [],
      size: 0
    },
    audio = {
      data: [],
      size: 0
    },
    timedMetadata = {
      data: [],
      size: 0
    },
    parsePes = function(payload, pes) {
      var ptsDtsFlags;

      // find out if this packets starts a new keyframe
      pes.dataAlignmentIndicator = (payload[6] & 0x04) !== 0;
      // PES packets may be annotated with a PTS value, or a PTS value
      // and a DTS value. Determine what combination of values is
      // available to work with.
      ptsDtsFlags = payload[7];

      // PTS and DTS are normally stored as a 33-bit number.  Javascript
      // performs all bitwise operations on 32-bit integers but javascript
      // supports a much greater range (52-bits) of integer using standard
      // mathematical operations.
      // We construct a 31-bit value using bitwise operators over the 31
      // most significant bits and then multiply by 4 (equal to a left-shift
      // of 2) before we add the final 2 least significant bits of the
      // timestamp (equal to an OR.)
      if (ptsDtsFlags & 0xC0) {
        // the PTS and DTS are not written out directly. For information
        // on how they are encoded, see
        // http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
        pes.pts = (payload[9] & 0x0E) << 27
          | (payload[10] & 0xFF) << 20
          | (payload[11] & 0xFE) << 12
          | (payload[12] & 0xFF) <<  5
          | (payload[13] & 0xFE) >>>  3;
        pes.pts *= 4; // Left shift by 2
        pes.pts += (payload[13] & 0x06) >>> 1; // OR by the two LSBs
        pes.dts = pes.pts;
        if (ptsDtsFlags & 0x40) {
          pes.dts = (payload[14] & 0x0E ) << 27
            | (payload[15] & 0xFF ) << 20
            | (payload[16] & 0xFE ) << 12
            | (payload[17] & 0xFF ) << 5
            | (payload[18] & 0xFE ) >>> 3;
          pes.dts *= 4; // Left shift by 2
          pes.dts += (payload[18] & 0x06) >>> 1; // OR by the two LSBs
        }
      }

      // the data section starts immediately after the PES header.
      // pes_header_data_length specifies the number of header bytes
      // that follow the last byte of the field.
      pes.data = payload.subarray(9 + payload[8]);
    },
    flushStream = function(stream, type) {
      var
        packetData = new Uint8Array(stream.size),
        event = {
          type: type
        },
        i = 0,
        fragment;

      // do nothing if there is no buffered data
      if (!stream.data.length) {
        return;
      }
      event.trackId = stream.data[0].pid;

      // reassemble the packet
      while (stream.data.length) {
        fragment = stream.data.shift();

        packetData.set(fragment.data, i);
        i += fragment.data.byteLength;
      }

      // parse assembled packet's PES header
      parsePes(packetData, event);

      stream.size = 0;

      self.trigger('data', event);
    },
    self;

  ElementaryStream.prototype.init.call(this);
  self = this;

  this.push = function(data) {
    ({
      pat: function() {
        // we have to wait for the PMT to arrive as well before we
        // have any meaningful metadata
      },
      pes: function() {
        var stream, streamType;

        switch (data.streamType) {
        case StreamTypes.H264_STREAM_TYPE:
        case m2tsStreamTypes.H264_STREAM_TYPE:
          stream = video;
          streamType = 'video';
          break;
        case StreamTypes.ADTS_STREAM_TYPE:
          stream = audio;
          streamType = 'audio';
          break;
        case StreamTypes.METADATA_STREAM_TYPE:
          stream = timedMetadata;
          streamType = 'timed-metadata';
          break;
        default:
          // ignore unknown stream types
          return;
        }

        // if a new packet is starting, we can flush the completed
        // packet
        if (data.payloadUnitStartIndicator) {
          flushStream(stream, streamType);
        }

        // buffer this fragment until we are sure we've received the
        // complete payload
        stream.data.push(data);
        stream.size += data.data.byteLength;
      },
      pmt: function() {
        var
          event = {
            type: 'metadata',
            tracks: []
          },
          programMapTable = data.programMapTable,
          k,
          track;

        // translate streams to tracks
        for (k in programMapTable) {
          if (programMapTable.hasOwnProperty(k)) {
            track = {
              timelineStartInfo: {
                baseMediaDecodeTime: 0
              }
            };
            track.id = +k;
            if (programMapTable[k] === m2tsStreamTypes.H264_STREAM_TYPE) {
              track.codec = 'avc';
              track.type = 'video';
            } else if (programMapTable[k] === m2tsStreamTypes.ADTS_STREAM_TYPE) {
              track.codec = 'adts';
              track.type = 'audio';
            }
            event.tracks.push(track);
          }
        }
        self.trigger('data', event);
      }
    })[data.type]();
  };

  /**
   * Flush any remaining input. Video PES packets may be of variable
   * length. Normally, the start of a new video packet can trigger the
   * finalization of the previous packet. That is not possible if no
   * more video is forthcoming, however. In that case, some other
   * mechanism (like the end of the file) has to be employed. When it is
   * clear that no additional data is forthcoming, calling this method
   * will flush the buffered packets.
   */
  this.flush = function() {
    // !!THIS ORDER IS IMPORTANT!!
    // video first then audio
    flushStream(video, 'video');
    flushStream(audio, 'audio');
    flushStream(timedMetadata, 'timed-metadata');
    this.trigger('done');
  };
};
ElementaryStream.prototype = new Stream();

var m2ts = {
  PAT_PID: 0x0000,
  MP2T_PACKET_LENGTH: MP2T_PACKET_LENGTH,
  TransportPacketStream: TransportPacketStream,
  TransportParseStream: TransportParseStream,
  ElementaryStream: ElementaryStream,
  CaptionStream: CaptionStream.CaptionStream,
  Cea608Stream: CaptionStream.Cea608Stream,
  MetadataStream: require('./metadata-stream'),
};

for (var type in StreamTypes) {
  if (StreamTypes.hasOwnProperty(type)) {
    m2ts[type] = StreamTypes[type];
  }
}

module.exports = m2ts;

},{"../utils/stream.js":20,"./caption-stream":9,"./metadata-stream":12,"./stream-types":13,"./stream-types.js":13}],12:[function(require,module,exports){
/**
 * Accepts program elementary stream (PES) data events and parses out
 * ID3 metadata from them, if present.
 * @see http://id3.org/id3v2.3.0
 */
'use strict';
var
  Stream = require('../utils/stream'),
  StreamTypes = require('./stream-types'),
  // return a percent-encoded representation of the specified byte range
  // @see http://en.wikipedia.org/wiki/Percent-encoding
  percentEncode = function(bytes, start, end) {
    var i, result = '';
    for (i = start; i < end; i++) {
      result += '%' + ('00' + bytes[i].toString(16)).slice(-2);
    }
    return result;
  },
  // return the string representation of the specified byte range,
  // interpreted as UTf-8.
  parseUtf8 = function(bytes, start, end) {
    return decodeURIComponent(percentEncode(bytes, start, end));
  },
  // return the string representation of the specified byte range,
  // interpreted as ISO-8859-1.
  parseIso88591 = function(bytes, start, end) {
    return unescape(percentEncode(bytes, start, end)); // jshint ignore:line
  },
  parseSyncSafeInteger = function (data) {
    return (data[0] << 21) |
            (data[1] << 14) |
            (data[2] << 7) |
            (data[3]);
  },
  tagParsers = {
    'TXXX': function(tag) {
      var i;
      if (tag.data[0] !== 3) {
        // ignore frames with unrecognized character encodings
        return;
      }

      for (i = 1; i < tag.data.length; i++) {
        if (tag.data[i] === 0) {
          // parse the text fields
          tag.description = parseUtf8(tag.data, 1, i);
          // do not include the null terminator in the tag value
          tag.value = parseUtf8(tag.data, i + 1, tag.data.length - 1);
          break;
        }
      }
      tag.data = tag.value;
    },
    'WXXX': function(tag) {
      var i;
      if (tag.data[0] !== 3) {
        // ignore frames with unrecognized character encodings
        return;
      }

      for (i = 1; i < tag.data.length; i++) {
        if (tag.data[i] === 0) {
          // parse the description and URL fields
          tag.description = parseUtf8(tag.data, 1, i);
          tag.url = parseUtf8(tag.data, i + 1, tag.data.length);
          break;
        }
      }
    },
    'PRIV': function(tag) {
      var i;

      for (i = 0; i < tag.data.length; i++) {
        if (tag.data[i] === 0) {
          // parse the description and URL fields
          tag.owner = parseIso88591(tag.data, 0, i);
          break;
        }
      }
      tag.privateData = tag.data.subarray(i + 1);
      tag.data = tag.privateData;
    }
  },
  MetadataStream;

MetadataStream = function(options) {
  var
    settings = {
      debug: !!(options && options.debug),

      // the bytes of the program-level descriptor field in MP2T
      // see ISO/IEC 13818-1:2013 (E), section 2.6 "Program and
      // program element descriptors"
      descriptor: options && options.descriptor
    },
    // the total size in bytes of the ID3 tag being parsed
    tagSize = 0,
    // tag data that is not complete enough to be parsed
    buffer = [],
    // the total number of bytes currently in the buffer
    bufferSize = 0,
    i;

  MetadataStream.prototype.init.call(this);

  // calculate the text track in-band metadata track dispatch type
  // https://html.spec.whatwg.org/multipage/embedded-content.html#steps-to-expose-a-media-resource-specific-text-track
  this.dispatchType = StreamTypes.METADATA_STREAM_TYPE.toString(16);
  if (settings.descriptor) {
    for (i = 0; i < settings.descriptor.length; i++) {
      this.dispatchType += ('00' + settings.descriptor[i].toString(16)).slice(-2);
    }
  }

  this.push = function(chunk) {
    var tag, frameStart, frameSize, frame, i, frameHeader;
    if (chunk.type !== 'timed-metadata') {
      return;
    }

    // if data_alignment_indicator is set in the PES header,
    // we must have the start of a new ID3 tag. Assume anything
    // remaining in the buffer was malformed and throw it out
    if (chunk.dataAlignmentIndicator) {
      bufferSize = 0;
      buffer.length = 0;
    }

    // ignore events that don't look like ID3 data
    if (buffer.length === 0 &&
        (chunk.data.length < 10 ||
          chunk.data[0] !== 'I'.charCodeAt(0) ||
          chunk.data[1] !== 'D'.charCodeAt(0) ||
          chunk.data[2] !== '3'.charCodeAt(0))) {
      if (settings.debug) {
        console.log('Skipping unrecognized metadata packet');
      }
      return;
    }

    // add this chunk to the data we've collected so far

    buffer.push(chunk);
    bufferSize += chunk.data.byteLength;

    // grab the size of the entire frame from the ID3 header
    if (buffer.length === 1) {
      // the frame size is transmitted as a 28-bit integer in the
      // last four bytes of the ID3 header.
      // The most significant bit of each byte is dropped and the
      // results concatenated to recover the actual value.
      tagSize = parseSyncSafeInteger(chunk.data.subarray(6, 10));

      // ID3 reports the tag size excluding the header but it's more
      // convenient for our comparisons to include it
      tagSize += 10;
    }

    // if the entire frame has not arrived, wait for more data
    if (bufferSize < tagSize) {
      return;
    }

    // collect the entire frame so it can be parsed
    tag = {
      data: new Uint8Array(tagSize),
      frames: [],
      pts: buffer[0].pts,
      dts: buffer[0].dts
    };
    for (i = 0; i < tagSize;) {
      tag.data.set(buffer[0].data.subarray(0, tagSize - i), i);
      i += buffer[0].data.byteLength;
      bufferSize -= buffer[0].data.byteLength;
      buffer.shift();
    }

    // find the start of the first frame and the end of the tag
    frameStart = 10;
    if (tag.data[5] & 0x40) {
      // advance the frame start past the extended header
      frameStart += 4; // header size field
      frameStart += parseSyncSafeInteger(tag.data.subarray(10, 14));

      // clip any padding off the end
      tagSize -= parseSyncSafeInteger(tag.data.subarray(16, 20));
    }

    // parse one or more ID3 frames
    // http://id3.org/id3v2.3.0#ID3v2_frame_overview
    do {
      // determine the number of bytes in this frame
      frameSize = parseSyncSafeInteger(tag.data.subarray(frameStart + 4, frameStart + 8));
      if (frameSize < 1) {
        return console.log('Malformed ID3 frame encountered. Skipping metadata parsing.');
      }
      frameHeader = String.fromCharCode(tag.data[frameStart],
                                        tag.data[frameStart + 1],
                                        tag.data[frameStart + 2],
                                        tag.data[frameStart + 3]);


      frame = {
        id: frameHeader,
        data: tag.data.subarray(frameStart + 10, frameStart + frameSize + 10)
      };
      frame.key = frame.id;
      if (tagParsers[frame.id]) {
        tagParsers[frame.id](frame);
        if (frame.owner === 'com.apple.streaming.transportStreamTimestamp') {
          var
            d = frame.data,
            size = ((d[3] & 0x01)  << 30) |
                   (d[4]  << 22) |
                   (d[5] << 14) |
                   (d[6] << 6) |
                   (d[7] >>> 2);

          size *= 4;
          size += d[7] & 0x03;
          frame.timeStamp = size;
          this.trigger('timestamp', frame);
        }
      }
      tag.frames.push(frame);

      frameStart += 10; // advance past the frame header
      frameStart += frameSize; // advance past the frame body
    } while (frameStart < tagSize);
    this.trigger('data', tag);
  };
};
MetadataStream.prototype = new Stream();

module.exports = MetadataStream;

},{"../utils/stream":20,"./stream-types":13}],13:[function(require,module,exports){
'use strict';

module.exports = {
  H264_STREAM_TYPE: 0x1B,
  ADTS_STREAM_TYPE: 0x0F,
  METADATA_STREAM_TYPE: 0x15
};

},{}],14:[function(require,module,exports){
module.exports = {
  generator: require('./mp4-generator'),
  Transmuxer: require('./transmuxer').Transmuxer,
  AudioSegmentStream: require('./transmuxer').AudioSegmentStream,
  VideoSegmentStream: require('./transmuxer').VideoSegmentStream,
  tools: require('../tools/mp4-inspector'),
};

},{"../tools/mp4-inspector":18,"./mp4-generator":15,"./transmuxer":16}],15:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Functions that generate fragmented MP4s suitable for use with Media
 * Source Extensions.
 */
'use strict';

var box, dinf, esds, ftyp, mdat, mfhd, minf, moof, moov, mvex, mvhd, trak,
    tkhd, mdia, mdhd, hdlr, sdtp, stbl, stsd, styp, traf, trex, trun,
    types, MAJOR_BRAND, MINOR_VERSION, AVC1_BRAND, VIDEO_HDLR,
    AUDIO_HDLR, HDLR_TYPES, VMHD, SMHD, DREF, STCO, STSC, STSZ, STTS;

// pre-calculate constants
(function() {
  var i;
  types = {
    avc1: [], // codingname
    avcC: [],
    btrt: [],
    dinf: [],
    dref: [],
    esds: [],
    ftyp: [],
    hdlr: [],
    mdat: [],
    mdhd: [],
    mdia: [],
    mfhd: [],
    minf: [],
    moof: [],
    moov: [],
    mp4a: [], // codingname
    mvex: [],
    mvhd: [],
    sdtp: [],
    smhd: [],
    stbl: [],
    stco: [],
    stsc: [],
    stsd: [],
    stsz: [],
    stts: [],
    styp: [],
    tfdt: [],
    tfhd: [],
    traf: [],
    trak: [],
    trun: [],
    trex: [],
    tkhd: [],
    vmhd: []
  };

  // In environments where Uint8Array is undefined (e.g., IE8), skip set up so that we
  // don't throw an error
  if (typeof Uint8Array === 'undefined') {
    return;
  }

  for (i in types) {
    if (types.hasOwnProperty(i)) {
      types[i] = [
        i.charCodeAt(0),
        i.charCodeAt(1),
        i.charCodeAt(2),
        i.charCodeAt(3)
      ];
    }
  }

  MAJOR_BRAND = new Uint8Array([
    'i'.charCodeAt(0),
    's'.charCodeAt(0),
    'o'.charCodeAt(0),
    'm'.charCodeAt(0)
  ]);
  AVC1_BRAND = new Uint8Array([
    'a'.charCodeAt(0),
    'v'.charCodeAt(0),
    'c'.charCodeAt(0),
    '1'.charCodeAt(0)
  ]);
  MINOR_VERSION = new Uint8Array([0, 0, 0, 1]);
  VIDEO_HDLR = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x76, 0x69, 0x64, 0x65, // handler_type: 'vide'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x56, 0x69, 0x64, 0x65,
    0x6f, 0x48, 0x61, 0x6e,
    0x64, 0x6c, 0x65, 0x72, 0x00 // name: 'VideoHandler'
  ]);
  AUDIO_HDLR = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x73, 0x6f, 0x75, 0x6e, // handler_type: 'soun'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x53, 0x6f, 0x75, 0x6e,
    0x64, 0x48, 0x61, 0x6e,
    0x64, 0x6c, 0x65, 0x72, 0x00 // name: 'SoundHandler'
  ]);
  HDLR_TYPES = {
    "video":VIDEO_HDLR,
    "audio": AUDIO_HDLR
  };
  DREF = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x01, // entry_count
    0x00, 0x00, 0x00, 0x0c, // entry_size
    0x75, 0x72, 0x6c, 0x20, // 'url' type
    0x00, // version 0
    0x00, 0x00, 0x01 // entry_flags
  ]);
  SMHD = new Uint8Array([
    0x00,             // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00,       // balance, 0 means centered
    0x00, 0x00        // reserved
  ]);
  STCO = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00 // entry_count
  ]);
  STSC = STCO;
  STSZ = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // sample_size
    0x00, 0x00, 0x00, 0x00, // sample_count
  ]);
  STTS = STCO;
  VMHD = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x01, // flags
    0x00, 0x00, // graphicsmode
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00 // opcolor
  ]);
})();

box = function(type) {
  var
    payload = [],
    size = 0,
    i,
    result,
    view;

  for (i = 1; i < arguments.length; i++) {
    payload.push(arguments[i]);
  }

  i = payload.length;

  // calculate the total size we need to allocate
  while (i--) {
    size += payload[i].byteLength;
  }
  result = new Uint8Array(size + 8);
  view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, result.byteLength);
  result.set(type, 4);

  // copy the payload into the result
  for (i = 0, size = 8; i < payload.length; i++) {
    result.set(payload[i], size);
    size += payload[i].byteLength;
  }
  return result;
};

dinf = function() {
  return box(types.dinf, box(types.dref, DREF));
};

esds = function(track) {
  return box(types.esds, new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags

    // ES_Descriptor
    0x03, // tag, ES_DescrTag
    0x19, // length
    0x00, 0x00, // ES_ID
    0x00, // streamDependenceFlag, URL_flag, reserved, streamPriority

    // DecoderConfigDescriptor
    0x04, // tag, DecoderConfigDescrTag
    0x11, // length
    0x40, // object type
    0x15,  // streamType
    0x00, 0x06, 0x00, // bufferSizeDB
    0x00, 0x00, 0xda, 0xc0, // maxBitrate
    0x00, 0x00, 0xda, 0xc0, // avgBitrate

    // DecoderSpecificInfo
    0x05, // tag, DecoderSpecificInfoTag
    0x02, // length
    // ISO/IEC 14496-3, AudioSpecificConfig
    // for samplingFrequencyIndex see ISO/IEC 13818-7:2006, 8.1.3.2.2, Table 35
    (track.audioobjecttype << 3) | (track.samplingfrequencyindex >>> 1),
    (track.samplingfrequencyindex << 7) | (track.channelcount << 3),
    0x06, 0x01, 0x02 // GASpecificConfig
  ]));
};

ftyp = function() {
  return box(types.ftyp, MAJOR_BRAND, MINOR_VERSION, MAJOR_BRAND, AVC1_BRAND);
};

hdlr = function(type) {
  return box(types.hdlr, HDLR_TYPES[type]);
};
mdat = function(data) {
  return box(types.mdat, data);
};
mdhd = function(track) {
  var result = new Uint8Array([
    0x00,                   // version 0
    0x00, 0x00, 0x00,       // flags
    0x00, 0x00, 0x00, 0x02, // creation_time
    0x00, 0x00, 0x00, 0x03, // modification_time
    0x00, 0x01, 0x5f, 0x90, // timescale, 90,000 "ticks" per second

    (track.duration >>> 24) & 0xFF,
    (track.duration >>> 16) & 0xFF,
    (track.duration >>>  8) & 0xFF,
    track.duration & 0xFF,  // duration
    0x55, 0xc4,             // 'und' language (undetermined)
    0x00, 0x00
  ]);

  // Use the sample rate from the track metadata, when it is
  // defined. The sample rate can be parsed out of an ADTS header, for
  // instance.
  if (track.samplerate) {
    result[12] = (track.samplerate >>> 24) & 0xFF;
    result[13] = (track.samplerate >>> 16) & 0xFF;
    result[14] = (track.samplerate >>>  8) & 0xFF;
    result[15] = (track.samplerate)        & 0xFF;
  }

  return box(types.mdhd, result);
};
mdia = function(track) {
  return box(types.mdia, mdhd(track), hdlr(track.type), minf(track));
};
mfhd = function(sequenceNumber) {
  return box(types.mfhd, new Uint8Array([
    0x00,
    0x00, 0x00, 0x00, // flags
    (sequenceNumber & 0xFF000000) >> 24,
    (sequenceNumber & 0xFF0000) >> 16,
    (sequenceNumber & 0xFF00) >> 8,
    sequenceNumber & 0xFF, // sequence_number
  ]));
};
minf = function(track) {
  return box(types.minf,
             track.type === 'video' ? box(types.vmhd, VMHD) : box(types.smhd, SMHD),
             dinf(),
             stbl(track));
};
moof = function(sequenceNumber, tracks) {
  var
    trackFragments = [],
    i = tracks.length;
  // build traf boxes for each track fragment
  while (i--) {
    trackFragments[i] = traf(tracks[i]);
  }
  return box.apply(null, [
    types.moof,
    mfhd(sequenceNumber)
  ].concat(trackFragments));
};
/**
 * Returns a movie box.
 * @param tracks {array} the tracks associated with this movie
 * @see ISO/IEC 14496-12:2012(E), section 8.2.1
 */
moov = function(tracks) {
  var
    i = tracks.length,
    boxes = [];

  while (i--) {
    boxes[i] = trak(tracks[i]);
  }

  return box.apply(null, [types.moov, mvhd(0xffffffff)].concat(boxes).concat(mvex(tracks)));
};
mvex = function(tracks) {
  var
    i = tracks.length,
    boxes = [];

  while (i--) {
    boxes[i] = trex(tracks[i]);
  }
  return box.apply(null, [types.mvex].concat(boxes));
};
mvhd = function(duration) {
  var
    bytes = new Uint8Array([
      0x00, // version 0
      0x00, 0x00, 0x00, // flags
      0x00, 0x00, 0x00, 0x01, // creation_time
      0x00, 0x00, 0x00, 0x02, // modification_time
      0x00, 0x01, 0x5f, 0x90, // timescale, 90,000 "ticks" per second
      (duration & 0xFF000000) >> 24,
      (duration & 0xFF0000) >> 16,
      (duration & 0xFF00) >> 8,
      duration & 0xFF, // duration
      0x00, 0x01, 0x00, 0x00, // 1.0 rate
      0x01, 0x00, // 1.0 volume
      0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00, // transformation: unity matrix
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, // pre_defined
      0xff, 0xff, 0xff, 0xff // next_track_ID
    ]);
  return box(types.mvhd, bytes);
};

sdtp = function(track) {
  var
    samples = track.samples || [],
    bytes = new Uint8Array(4 + samples.length),
    flags,
    i;

  // leave the full box header (4 bytes) all zero

  // write the sample table
  for (i = 0; i < samples.length; i++) {
    flags = samples[i].flags;

    bytes[i + 4] = (flags.dependsOn << 4) |
      (flags.isDependedOn << 2) |
      (flags.hasRedundancy);
  }

  return box(types.sdtp,
             bytes);
};

stbl = function(track) {
  return box(types.stbl,
             stsd(track),
             box(types.stts, STTS),
             box(types.stsc, STSC),
             box(types.stsz, STSZ),
             box(types.stco, STCO));
};

(function() {
  var videoSample, audioSample;

  stsd = function(track) {

    return box(types.stsd, new Uint8Array([
      0x00, // version 0
      0x00, 0x00, 0x00, // flags
      0x00, 0x00, 0x00, 0x01
    ]), track.type === 'video' ? videoSample(track) : audioSample(track));
  };

  videoSample = function(track) {
    var
      sps = track.sps || [],
      pps = track.pps || [],
      sequenceParameterSets = [],
      pictureParameterSets = [],
      i;

    // assemble the SPSs
    for (i = 0; i < sps.length; i++) {
      sequenceParameterSets.push((sps[i].byteLength & 0xFF00) >>> 8);
      sequenceParameterSets.push((sps[i].byteLength & 0xFF)); // sequenceParameterSetLength
      sequenceParameterSets = sequenceParameterSets.concat(Array.prototype.slice.call(sps[i])); // SPS
    }

    // assemble the PPSs
    for (i = 0; i < pps.length; i++) {
      pictureParameterSets.push((pps[i].byteLength & 0xFF00) >>> 8);
      pictureParameterSets.push((pps[i].byteLength & 0xFF));
      pictureParameterSets = pictureParameterSets.concat(Array.prototype.slice.call(pps[i]));
    }

    return box(types.avc1, new Uint8Array([
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, // reserved
      0x00, 0x01, // data_reference_index
      0x00, 0x00, // pre_defined
      0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, // pre_defined
      (track.width & 0xff00) >> 8,
      track.width & 0xff, // width
      (track.height & 0xff00) >> 8,
      track.height & 0xff, // height
      0x00, 0x48, 0x00, 0x00, // horizresolution
      0x00, 0x48, 0x00, 0x00, // vertresolution
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x01, // frame_count
      0x13,
      0x76, 0x69, 0x64, 0x65,
      0x6f, 0x6a, 0x73, 0x2d,
      0x63, 0x6f, 0x6e, 0x74,
      0x72, 0x69, 0x62, 0x2d,
      0x68, 0x6c, 0x73, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, // compressorname
      0x00, 0x18, // depth = 24
      0x11, 0x11 // pre_defined = -1
    ]), box(types.avcC, new Uint8Array([
      0x01, // configurationVersion
      track.profileIdc, // AVCProfileIndication
      track.profileCompatibility, // profile_compatibility
      track.levelIdc, // AVCLevelIndication
      0xff // lengthSizeMinusOne, hard-coded to 4 bytes
    ].concat([
      sps.length // numOfSequenceParameterSets
    ]).concat(sequenceParameterSets).concat([
      pps.length // numOfPictureParameterSets
    ]).concat(pictureParameterSets))), // "PPS"
            box(types.btrt, new Uint8Array([
              0x00, 0x1c, 0x9c, 0x80, // bufferSizeDB
              0x00, 0x2d, 0xc6, 0xc0, // maxBitrate
              0x00, 0x2d, 0xc6, 0xc0
            ])) // avgBitrate
              );
  };

  audioSample = function(track) {
    return box(types.mp4a, new Uint8Array([

      // SampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, // reserved
      0x00, 0x01, // data_reference_index

      // AudioSampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      (track.channelcount & 0xff00) >> 8,
      (track.channelcount & 0xff), // channelcount

      (track.samplesize & 0xff00) >> 8,
      (track.samplesize & 0xff), // samplesize
      0x00, 0x00, // pre_defined
      0x00, 0x00, // reserved

      (track.samplerate & 0xff00) >> 8,
      (track.samplerate & 0xff),
      0x00, 0x00 // samplerate, 16.16

      // MP4AudioSampleEntry, ISO/IEC 14496-14
    ]), esds(track));
  };
})();

styp = function() {
  return box(types.styp, MAJOR_BRAND, MINOR_VERSION, MAJOR_BRAND);
};

tkhd = function(track) {
  var result = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x07, // flags
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (track.id & 0xFF000000) >> 24,
    (track.id & 0xFF0000) >> 16,
    (track.id & 0xFF00) >> 8,
    track.id & 0xFF, // track_ID
    0x00, 0x00, 0x00, 0x00, // reserved
    (track.duration & 0xFF000000) >> 24,
    (track.duration & 0xFF0000) >> 16,
    (track.duration & 0xFF00) >> 8,
    track.duration & 0xFF, // duration
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, // layer
    0x00, 0x00, // alternate_group
    0x01, 0x00, // non-audio track volume
    0x00, 0x00, // reserved
    0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x40, 0x00, 0x00, 0x00, // transformation: unity matrix
    (track.width & 0xFF00) >> 8,
    track.width & 0xFF,
    0x00, 0x00, // width
    (track.height & 0xFF00) >> 8,
    track.height & 0xFF,
    0x00, 0x00 // height
  ]);

  return box(types.tkhd, result);
};

/**
 * Generate a track fragment (traf) box. A traf box collects metadata
 * about tracks in a movie fragment (moof) box.
 */
traf = function(track) {
  var trackFragmentHeader, trackFragmentDecodeTime,
      trackFragmentRun, sampleDependencyTable, dataOffset;

  trackFragmentHeader = box(types.tfhd, new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x3a, // flags
    (track.id & 0xFF000000) >> 24,
    (track.id & 0xFF0000) >> 16,
    (track.id & 0xFF00) >> 8,
    (track.id & 0xFF), // track_ID
    0x00, 0x00, 0x00, 0x01, // sample_description_index
    0x00, 0x00, 0x00, 0x00, // default_sample_duration
    0x00, 0x00, 0x00, 0x00, // default_sample_size
    0x00, 0x00, 0x00, 0x00  // default_sample_flags
  ]));

  trackFragmentDecodeTime = box(types.tfdt, new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    // baseMediaDecodeTime
    (track.baseMediaDecodeTime >>> 24) & 0xFF,
    (track.baseMediaDecodeTime >>> 16) & 0xFF,
    (track.baseMediaDecodeTime >>> 8) & 0xFF,
    track.baseMediaDecodeTime & 0xFF
  ]));

  // the data offset specifies the number of bytes from the start of
  // the containing moof to the first payload byte of the associated
  // mdat
  dataOffset = (32 + // tfhd
                16 + // tfdt
                8 +  // traf header
                16 + // mfhd
                8 +  // moof header
                8);  // mdat header

  // audio tracks require less metadata
  if (track.type === 'audio') {
    trackFragmentRun = trun(track, dataOffset);
    return box(types.traf,
               trackFragmentHeader,
               trackFragmentDecodeTime,
               trackFragmentRun);
  }

  // video tracks should contain an independent and disposable samples
  // box (sdtp)
  // generate one and adjust offsets to match
  sampleDependencyTable = sdtp(track);
  trackFragmentRun = trun(track,
                          sampleDependencyTable.length + dataOffset);
  return box(types.traf,
             trackFragmentHeader,
             trackFragmentDecodeTime,
             trackFragmentRun,
             sampleDependencyTable);
};

/**
 * Generate a track box.
 * @param track {object} a track definition
 * @return {Uint8Array} the track box
 */
trak = function(track) {
  track.duration = track.duration || 0xffffffff;
  return box(types.trak,
             tkhd(track),
             mdia(track));
};

trex = function(track) {
  var result = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    (track.id & 0xFF000000) >> 24,
    (track.id & 0xFF0000) >> 16,
    (track.id & 0xFF00) >> 8,
    (track.id & 0xFF), // track_ID
    0x00, 0x00, 0x00, 0x01, // default_sample_description_index
    0x00, 0x00, 0x00, 0x00, // default_sample_duration
    0x00, 0x00, 0x00, 0x00, // default_sample_size
    0x00, 0x01, 0x00, 0x01 // default_sample_flags
  ]);
  // the last two bytes of default_sample_flags is the sample
  // degradation priority, a hint about the importance of this sample
  // relative to others. Lower the degradation priority for all sample
  // types other than video.
  if (track.type !== 'video') {
    result[result.length - 1] = 0x00;
  }

  return box(types.trex, result);
};

(function() {
  var audioTrun, videoTrun, trunHeader;

  // This method assumes all samples are uniform. That is, if a
  // duration is present for the first sample, it will be present for
  // all subsequent samples.
  // see ISO/IEC 14496-12:2012, Section 8.8.8.1
  trunHeader = function(samples, offset) {
    var durationPresent = 0, sizePresent = 0,
        flagsPresent = 0, compositionTimeOffset = 0;

    // trun flag constants
    if (samples.length) {
      if (samples[0].duration !== undefined) {
        durationPresent = 0x1;
      }
      if (samples[0].size !== undefined) {
        sizePresent = 0x2;
      }
      if (samples[0].flags !== undefined) {
        flagsPresent = 0x4;
      }
      if (samples[0].compositionTimeOffset !== undefined) {
        compositionTimeOffset = 0x8;
      }
    }

    return [
      0x00, // version 0
      0x00,
      durationPresent | sizePresent | flagsPresent | compositionTimeOffset,
      0x01, // flags
      (samples.length & 0xFF000000) >>> 24,
      (samples.length & 0xFF0000) >>> 16,
      (samples.length & 0xFF00) >>> 8,
      samples.length & 0xFF, // sample_count
      (offset & 0xFF000000) >>> 24,
      (offset & 0xFF0000) >>> 16,
      (offset & 0xFF00) >>> 8,
      offset & 0xFF // data_offset
    ];
  };

  videoTrun = function(track, offset) {
    var bytes, samples, sample, i;

    samples = track.samples || [];
    offset += 8 + 12 + (16 * samples.length);

    bytes = trunHeader(samples, offset);

    for (i = 0; i < samples.length; i++) {
      sample = samples[i];
      bytes = bytes.concat([
        (sample.duration & 0xFF000000) >>> 24,
        (sample.duration & 0xFF0000) >>> 16,
        (sample.duration & 0xFF00) >>> 8,
        sample.duration & 0xFF, // sample_duration
        (sample.size & 0xFF000000) >>> 24,
        (sample.size & 0xFF0000) >>> 16,
        (sample.size & 0xFF00) >>> 8,
        sample.size & 0xFF, // sample_size
        (sample.flags.isLeading << 2) | sample.flags.dependsOn,
        (sample.flags.isDependedOn << 6) |
          (sample.flags.hasRedundancy << 4) |
          (sample.flags.paddingValue << 1) |
          sample.flags.isNonSyncSample,
        sample.flags.degradationPriority & 0xF0 << 8,
        sample.flags.degradationPriority & 0x0F, // sample_flags
        (sample.compositionTimeOffset & 0xFF000000) >>> 24,
        (sample.compositionTimeOffset & 0xFF0000) >>> 16,
        (sample.compositionTimeOffset & 0xFF00) >>> 8,
        sample.compositionTimeOffset & 0xFF // sample_composition_time_offset
      ]);
    }
    return box(types.trun, new Uint8Array(bytes));
  };

  audioTrun = function(track, offset) {
    var bytes, samples, sample, i;

    samples = track.samples || [];
    offset += 8 + 12 + (8 * samples.length);

    bytes = trunHeader(samples, offset);

    for (i = 0; i < samples.length; i++) {
      sample = samples[i];
      bytes = bytes.concat([
        (sample.duration & 0xFF000000) >>> 24,
        (sample.duration & 0xFF0000) >>> 16,
        (sample.duration & 0xFF00) >>> 8,
        sample.duration & 0xFF, // sample_duration
        (sample.size & 0xFF000000) >>> 24,
        (sample.size & 0xFF0000) >>> 16,
        (sample.size & 0xFF00) >>> 8,
        sample.size & 0xFF]); // sample_size
    }

    return box(types.trun, new Uint8Array(bytes));
  };

  trun = function(track, offset) {
    if (track.type === 'audio') {
      return audioTrun(track, offset);
    } else {
      return videoTrun(track, offset);
    }
  };
})();

module.exports = {
  ftyp: ftyp,
  mdat: mdat,
  moof: moof,
  moov: moov,
  initSegment: function(tracks) {
    var
      fileType = ftyp(),
      movie = moov(tracks),
      result;

    result = new Uint8Array(fileType.byteLength + movie.byteLength);
    result.set(fileType);
    result.set(movie, fileType.byteLength);
    return result;
  }
};

},{}],16:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * A stream-based mp2t to mp4 converter. This utility can be used to
 * deliver mp4s to a SourceBuffer on platforms that support native
 * Media Source Extensions.
 */
'use strict';

var Stream = require('../utils/stream.js');
var mp4 = require('./mp4-generator.js');
var m2ts = require('../m2ts/m2ts.js');
var AdtsStream = require('../codecs/adts.js');
var H264Stream = require('../codecs/h264').H264Stream;
var AacStream = require('../aac');

// constants
var AUDIO_PROPERTIES = [
  'audioobjecttype',
  'channelcount',
  'samplerate',
  'samplingfrequencyindex',
  'samplesize'
];

var VIDEO_PROPERTIES = [
  'width',
  'height',
  'profileIdc',
  'levelIdc',
  'profileCompatibility',
];

// object types
var VideoSegmentStream, AudioSegmentStream, Transmuxer, CoalesceStream;

// Helper functions
var
  createDefaultSample,
  isLikelyAacData,
  collectDtsInfo,
  clearDtsInfo,
  calculateTrackBaseMediaDecodeTime,
  arrayEquals,
  sumFrameByteLengths;

/**
 * Default sample object
 * see ISO/IEC 14496-12:2012, section 8.6.4.3
 */
createDefaultSample = function () {
  return {
    size: 0,
    flags: {
      isLeading: 0,
      dependsOn: 1,
      isDependedOn: 0,
      hasRedundancy: 0,
      degradationPriority: 0
    }
  };
};

isLikelyAacData = function (data) {
  if ((data[0] === 'I'.charCodeAt(0)) &&
      (data[1] === 'D'.charCodeAt(0)) &&
      (data[2] === '3'.charCodeAt(0))) {
    return true;
  }
  return false;
};

/**
 * Compare two arrays (even typed) for same-ness
 */
arrayEquals = function(a, b) {
  var
    i;

  if (a.length !== b.length) {
    return false;
  }

  // compare the value of each element in the array
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Sum the `byteLength` properties of the data in each AAC frame
 */
sumFrameByteLengths = function(array) {
  var
    i,
    currentObj,
    sum = 0;

  // sum the byteLength's all each nal unit in the frame
  for (i = 0; i < array.length; i++) {
    currentObj = array[i];
    sum += currentObj.data.byteLength;
  }

  return sum;
};

/**
 * Constructs a single-track, ISO BMFF media segment from AAC data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 */
AudioSegmentStream = function(track) {
  var
    adtsFrames = [],
    sequenceNumber = 0,
    earliestAllowedDts = 0;

  AudioSegmentStream.prototype.init.call(this);

  this.push = function(data) {
    collectDtsInfo(track, data);

    if (track) {
      AUDIO_PROPERTIES.forEach(function(prop) {
        track[prop] = data[prop];
      });
    }

    // buffer audio data until end() is called
    adtsFrames.push(data);
  };

  this.setEarliestDts = function(earliestDts) {
    earliestAllowedDts = earliestDts - track.timelineStartInfo.baseMediaDecodeTime;
  };

  this.flush = function() {
    var
      frames,
      moof,
      mdat,
      boxes;

    // return early if no audio data has been observed
    if (adtsFrames.length === 0) {
      this.trigger('done', 'AudioSegmentStream');
      return;
    }

    frames = this.trimAdtsFramesByEarliestDts_(adtsFrames);

    // we have to build the index from byte locations to
    // samples (that is, adts frames) in the audio data
    track.samples = this.generateSampleTable_(frames);

    // concatenate the audio data to constuct the mdat
    mdat = mp4.mdat(this.concatenateFrameData_(frames));

    adtsFrames = [];

    calculateTrackBaseMediaDecodeTime(track);
    moof = mp4.moof(sequenceNumber, [track]);
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

    // bump the sequence number for next time
    sequenceNumber++;

    boxes.set(moof);
    boxes.set(mdat, moof.byteLength);

    clearDtsInfo(track);

    this.trigger('data', {track: track, boxes: boxes});
    this.trigger('done', 'AudioSegmentStream');
  };

  // If the audio segment extends before the earliest allowed dts
  // value, remove AAC frames until starts at or after the earliest
  // allowed DTS so that we don't end up with a negative baseMedia-
  // DecodeTime for the audio track
  this.trimAdtsFramesByEarliestDts_ = function(adtsFrames) {
    if (track.minSegmentDts >= earliestAllowedDts) {
      return adtsFrames;
    }

    // We will need to recalculate the earliest segment Dts
    track.minSegmentDts = Infinity;

    return adtsFrames.filter(function(currentFrame) {
      // If this is an allowed frame, keep it and record it's Dts
      if (currentFrame.dts >= earliestAllowedDts) {
        track.minSegmentDts = Math.min(track.minSegmentDts, currentFrame.dts);
        track.minSegmentPts = track.minSegmentDts;
        return true;
      }
      // Otherwise, discard it
      return false;
    });
  };

  // generate the track's raw mdat data from an array of frames
  this.generateSampleTable_ = function(frames) {
    var
      i,
      currentFrame,
      samples = [];

    for (i = 0; i < frames.length; i++) {
      currentFrame = frames[i];
      samples.push({
        size: currentFrame.data.byteLength,
        duration: 1024 // For AAC audio, all samples contain 1024 samples
      });
    }
    return samples;
  };

  // generate the track's sample table from an array of frames
  this.concatenateFrameData_ = function(frames) {
    var
      i,
      currentFrame,
      dataOffset = 0,
      data = new Uint8Array(sumFrameByteLengths(frames));

    for (i = 0; i < frames.length; i++) {
      currentFrame = frames[i];

      data.set(currentFrame.data, dataOffset);
      dataOffset += currentFrame.data.byteLength;
    }
    return data;
  };
};

AudioSegmentStream.prototype = new Stream();

/**
 * Constructs a single-track, ISO BMFF media segment from H264 data
 * events. The output of this stream can be fed to a SourceBuffer
 * configured with a suitable initialization segment.
 * @param track {object} track metadata configuration
 */
VideoSegmentStream = function(track) {
  var
    sequenceNumber = 0,
    nalUnits = [],
    config,
    pps;

  VideoSegmentStream.prototype.init.call(this);

  delete track.minPTS;

  this.gopCache_ = [];

  this.push = function(nalUnit) {
    collectDtsInfo(track, nalUnit);

    // record the track config
    if (nalUnit.nalUnitType === 'seq_parameter_set_rbsp' && !config) {
      config = nalUnit.config;
      track.sps = [nalUnit.data];

      VIDEO_PROPERTIES.forEach(function(prop) {
        track[prop] = config[prop];
      }, this);
    }

    if (nalUnit.nalUnitType === 'pic_parameter_set_rbsp' &&
        !pps) {
      pps = nalUnit.data;
      track.pps = [nalUnit.data];
    }

    // buffer video until flush() is called
    nalUnits.push(nalUnit);
  };

  this.flush = function() {
    var
      frames,
      gopForFusion,
      gops,
      moof,
      mdat,
      boxes;

    // Throw away nalUnits at the start of the byte stream until
    // we find the first AUD
    while (nalUnits.length) {
      if (nalUnits[0].nalUnitType === 'access_unit_delimiter_rbsp') {
        break;
      }
      nalUnits.shift();
    }

    // Return early if no video data has been observed
    if (nalUnits.length === 0) {
      this.resetStream_();
      this.trigger('done', 'VideoSegmentStream');
      return;
    }

    // Organize the raw nal-units into arrays that represent
    // higher-level constructs such as frames and gops
    // (group-of-pictures)
    frames = this.groupNalsIntoFrames_(nalUnits);
    gops = this.groupFramesIntoGops_(frames);

    // If the first frame of this fragment is not a keyframe we have
    // a problem since MSE (on Chrome) requires a leading keyframe.
    //
    // We have two approaches to repairing this situation:
    // 1) GOP-FUSION:
    //    This is where we keep track of the GOPS (group-of-pictures)
    //    from previous fragments and attempt to find one that we can
    //    prepend to the current fragment in order to create a valid
    //    fragment.
    // 2) KEYFRAME-PULLING:
    //    Here we search for the first keyframe in the fragment and
    //    throw away all the frames between the start of the fragment
    //    and that keyframe. We then extend the duration and pull the
    //    PTS of the keyframe forward so that it covers the time range
    //    of the frames that were disposed of.
    //
    // #1 is far prefereable over #2 which can cause "stuttering" but
    // requires more things to be just right.
    if (!gops[0][0].keyFrame) {
      // Search for a gop for fusion from our gopCache
      gopForFusion = this.getGopForFusion_(nalUnits[0], track);

      if (gopForFusion) {
        gops.unshift(gopForFusion);
        // Adjust Gops' metadata to account for the inclusion of the
        // new gop at the beginning
        gops.byteLength += gopForFusion.byteLength;
        gops.nalCount += gopForFusion.nalCount;
        gops.pts = gopForFusion.pts;
        gops.dts = gopForFusion.dts;
        gops.duration += gopForFusion.duration;
      } else {
        // If we didn't find a candidate gop fall back to keyrame-pulling
        gops = this.extendFirstKeyFrame_(gops);
      }
    }
    collectDtsInfo(track, gops);

    // First, we have to build the index from byte locations to
    // samples (that is, frames) in the video data
    track.samples = this.generateSampleTable_(gops);

    // Concatenate the video data and construct the mdat
    mdat = mp4.mdat(this.concatenateNalData_(gops));

    // save all the nals in the last GOP into the gop cache
    this.gopCache_.unshift({
      gop: gops.pop(),
      pps: track.pps,
      sps: track.sps
    });

    // Keep a maximum of 6 GOPs in the cache
    this.gopCache_.length = Math.min(6, this.gopCache_.length);

    // Clear nalUnits
    nalUnits = [];

    calculateTrackBaseMediaDecodeTime(track);

    this.trigger('timelineStartInfo', track.timelineStartInfo);

    moof = mp4.moof(sequenceNumber, [track]);

    // it would be great to allocate this array up front instead of
    // throwing away hundreds of media segment fragments
    boxes = new Uint8Array(moof.byteLength + mdat.byteLength);

    // Bump the sequence number for next time
    sequenceNumber++;

    boxes.set(moof);
    boxes.set(mdat, moof.byteLength);

    this.trigger('data', {track: track, boxes: boxes});

    this.resetStream_();

    // Continue with the flush process now
    this.trigger('done', 'VideoSegmentStream');
  };

  this.resetStream_ = function() {
    clearDtsInfo(track);

    // reset config and pps because they may differ across segments
    // for instance, when we are rendition switching
    config = undefined;
    pps = undefined;
  };

  // Search for a candidate Gop for gop-fusion from the gop cache and
  // return it or return null if no good candidate was found
  this.getGopForFusion_ = function (nalUnit) {
    var
      halfSecond = 45000, // Half-a-second in a 90khz clock
      allowableOverlap = 10000, // About 3 frames @ 30fps
      nearestDistance = Infinity,
      dtsDistance,
      nearestGopObj,
      currentGop,
      currentGopObj,
      i;

    // Search for the GOP nearest to the beginning of this nal unit
    for (i = 0; i < this.gopCache_.length; i++) {
      currentGopObj = this.gopCache_[i];
      currentGop = currentGopObj.gop;

      // Reject Gops with different SPS or PPS
      if (!(track.pps && arrayEquals(track.pps[0], currentGopObj.pps[0])) ||
          !(track.sps && arrayEquals(track.sps[0], currentGopObj.sps[0]))) {
        continue;
      }

      // Reject Gops that would require a negative baseMediaDecodeTime
      if (currentGop.dts < track.timelineStartInfo.dts) {
        continue;
      }

      // The distance between the end of the gop and the start of the nalUnit
      dtsDistance = (nalUnit.dts - currentGop.dts) - currentGop.duration;

      // Only consider GOPS that start before the nal unit and end within
      // a half-second of the nal unit
      if (dtsDistance >= -allowableOverlap &&
          dtsDistance <= halfSecond) {

        // Always use the closest GOP we found if there is more than
        // one candidate
        if (!nearestGopObj ||
            nearestDistance > dtsDistance) {
          nearestGopObj = currentGopObj;
          nearestDistance = dtsDistance;
        }
      }
    }

    if (nearestGopObj) {
      return nearestGopObj.gop;
    }
    return null;
  };

  this.extendFirstKeyFrame_ = function(gops) {
    var
      h, i,
      currentGop,
      newGops;

    if (!gops[0][0].keyFrame) {
      // Remove the first GOP
      currentGop = gops.shift();

      gops.byteLength -=  currentGop.byteLength;
      gops.nalCount -= currentGop.nalCount;

      // Extend the first frame of what is now the
      // first gop to cover the time period of the
      // frames we just removed
      gops[0][0].dts = currentGop.dts;
      gops[0][0].pts = currentGop.pts;
      gops[0][0].duration += currentGop.duration;
    }

    return gops;
  };

  // Convert an array of nal units into an array of frames with each frame being
  // composed of the nal units that make up that frame
  // Also keep track of cummulative data about the frame from the nal units such
  // as the frame duration, starting pts, etc.
  this.groupNalsIntoFrames_ = function(nalUnits) {
    var
      i,
      currentNal,
      startPts,
      startDts,
      currentFrame = [],
      frames = [];

    currentFrame.byteLength = 0;

    for (i = 0; i < nalUnits.length; i++) {
      currentNal = nalUnits[i];

      // Split on 'aud'-type nal units
      if (currentNal.nalUnitType === 'access_unit_delimiter_rbsp') {
        // Since the very first nal unit is expected to be an AUD
        // only push to the frames array when currentFrame is not empty
        if (currentFrame.length) {
          currentFrame.duration = currentNal.dts - currentFrame.dts;
          frames.push(currentFrame);
        }
        currentFrame = [currentNal];
        currentFrame.byteLength = currentNal.data.byteLength;
        currentFrame.pts = currentNal.pts;
        currentFrame.dts = currentNal.dts;
      } else {
        // Specifically flag key frames for ease of use later
        if (currentNal.nalUnitType === 'slice_layer_without_partitioning_rbsp_idr') {
          currentFrame.keyFrame = true;
        }
        currentFrame.duration = currentNal.dts - currentFrame.dts;
        currentFrame.byteLength += currentNal.data.byteLength;
        currentFrame.push(currentNal);
      }
    }

    // For the last frame, use the duration of the previous frame if we
    // have nothing better to go on
    if (frames.length &&
        (!currentFrame.duration ||
         currentFrame.duration <= 0)) {
      currentFrame.duration = frames[frames.length - 1].duration;
    }

    // Push the final frame
    frames.push(currentFrame);
    return frames;
  };

  // Convert an array of frames into an array of Gop with each Gop being composed
  // of the frames that make up that Gop
  // Also keep track of cummulative data about the Gop from the frames such as the
  // Gop duration, starting pts, etc.
  this.groupFramesIntoGops_ = function(frames) {
    var
      i,
      currentFrame,
      currentGop = [],
      gops = [];

    // We must pre-set some of the values on the Gop since we
    // keep running totals of these values
    currentGop.byteLength = 0;
    currentGop.nalCount = 0;
    currentGop.duration = 0;
    currentGop.pts = frames[0].pts;
    currentGop.dts = frames[0].dts;

    // store some metadata about all the Gops
    gops.byteLength = 0;
    gops.nalCount = 0;
    gops.duration = 0;
    gops.pts = frames[0].pts;
    gops.dts = frames[0].dts;

    for (i = 0; i < frames.length; i++) {
      currentFrame = frames[i];

      if (currentFrame.keyFrame) {
        // Since the very first frame is expected to be an keyframe
        // only push to the gops array when currentGop is not empty
        if (currentGop.length) {
          gops.push(currentGop);
          gops.byteLength += currentGop.byteLength;
          gops.nalCount += currentGop.nalCount;
          gops.duration += currentGop.duration;
        }

        currentGop = [currentFrame];
        currentGop.nalCount = currentFrame.length;
        currentGop.byteLength = currentFrame.byteLength;
        currentGop.pts = currentFrame.pts;
        currentGop.dts = currentFrame.dts;
        currentGop.duration = currentFrame.duration;
      } else {
        currentGop.duration += currentFrame.duration;
        currentGop.nalCount += currentFrame.length;
        currentGop.byteLength += currentFrame.byteLength;
        currentGop.push(currentFrame);
      }
    }

    if (gops.length && currentGop.duration <= 0) {
      currentGop.duration = gops[gops.length - 1].duration;
    }
    gops.byteLength += currentGop.byteLength;
    gops.nalCount += currentGop.nalCount;
    gops.duration += currentGop.duration;

    // push the final Gop
    gops.push(currentGop);
    return gops;
  };

  // generate the track's sample table from an array of gops
  this.generateSampleTable_ = function(gops, baseDataOffset) {
    var
      h, i,
      sample,
      currentGop,
      currentFrame,
      currentSample,
      dataOffset = baseDataOffset || 0,
      samples = [];

    for (h = 0; h < gops.length; h++) {
      currentGop = gops[h];

      for (i = 0; i < currentGop.length; i++) {
        currentFrame = currentGop[i];

        sample = createDefaultSample();

        sample.dataOffset = dataOffset;
        sample.compositionTimeOffset = currentFrame.pts - currentFrame.dts;
        sample.duration = currentFrame.duration;
        sample.size = 4 * currentFrame.length; // Space for nal unit size
        sample.size += currentFrame.byteLength;

        if (currentFrame.keyFrame) {
          sample.flags.dependsOn = 2;
        }

        dataOffset += sample.size;

        samples.push(sample);
      }
    }
    return samples;
  };

  // generate the track's raw mdat data from an array of gops
  this.concatenateNalData_ = function (gops) {
    var
      h, i, j,
      currentGop,
      currentFrame,
      currentNal,
      dataOffset = 0,
      nalsByteLength = gops.byteLength,
      numberOfNals = gops.nalCount,
      totalByteLength = nalsByteLength + 4 * numberOfNals,
      data = new Uint8Array(totalByteLength),
      view = new DataView(data.buffer);

    // For each Gop..
    for (h = 0; h < gops.length; h++) {
      currentGop = gops[h];

      // For each Frame..
      for (i = 0; i < currentGop.length; i++) {
        currentFrame = currentGop[i];

        // For each NAL..
        for (j = 0; j < currentFrame.length; j++) {
          currentNal = currentFrame[j];

          view.setUint32(dataOffset, currentNal.data.byteLength);
          dataOffset += 4;
          data.set(currentNal.data, dataOffset);
          dataOffset += currentNal.data.byteLength;
        }
      }
    }
    return data;
  };
};

VideoSegmentStream.prototype = new Stream();

/**
 * Store information about the start and end of the track and the
 * duration for each frame/sample we process in order to calculate
 * the baseMediaDecodeTime
 */
collectDtsInfo = function (track, data) {
  if (typeof data.pts === 'number') {
    if (track.timelineStartInfo.pts === undefined) {
      track.timelineStartInfo.pts = data.pts;
    }

    if (track.minSegmentPts === undefined) {
      track.minSegmentPts = data.pts;
    } else {
      track.minSegmentPts = Math.min(track.minSegmentPts, data.pts);
    }

    if (track.maxSegmentPts === undefined) {
      track.maxSegmentPts = data.pts;
    } else {
      track.maxSegmentPts = Math.max(track.maxSegmentPts, data.pts);
    }
  }

  if (typeof data.dts === 'number') {
    if (track.timelineStartInfo.dts === undefined) {
      track.timelineStartInfo.dts = data.dts;
    }

    if (track.minSegmentDts === undefined) {
      track.minSegmentDts = data.dts;
    } else {
      track.minSegmentDts = Math.min(track.minSegmentDts, data.dts);
    }

    if (track.maxSegmentDts === undefined) {
      track.maxSegmentDts = data.dts;
    } else {
      track.maxSegmentDts = Math.max(track.maxSegmentDts, data.dts);
    }
  }
};

/**
 * Clear values used to calculate the baseMediaDecodeTime between
 * tracks
 */
clearDtsInfo = function (track) {
  delete track.minSegmentDts;
  delete track.maxSegmentDts;
  delete track.minSegmentPts;
  delete track.maxSegmentPts;
};

/**
 * Calculate the track's baseMediaDecodeTime based on the earliest
 * DTS the transmuxer has ever seen and the minimum DTS for the
 * current track
 */
calculateTrackBaseMediaDecodeTime = function (track) {
  var
    oneSecondInPTS = 90000, // 90kHz clock
    scale,
    // Calculate the distance, in time, that this segment starts from the start
    // of the timeline (earliest time seen since the transmuxer initialized)
    timeSinceStartOfTimeline = track.minSegmentDts - track.timelineStartInfo.dts,
    // Calculate the first sample's effective compositionTimeOffset
    firstSampleCompositionOffset = track.minSegmentPts - track.minSegmentDts;

  // track.timelineStartInfo.baseMediaDecodeTime is the location, in time, where
  // we want the start of the first segment to be placed
  track.baseMediaDecodeTime = track.timelineStartInfo.baseMediaDecodeTime;

  // Add to that the distance this segment is from the very first
  track.baseMediaDecodeTime += timeSinceStartOfTimeline;

  // Subtract this segment's "compositionTimeOffset" so that the first frame of
  // this segment is displayed exactly at the `baseMediaDecodeTime` or at the
  // end of the previous segment
  track.baseMediaDecodeTime -= firstSampleCompositionOffset;

  // baseMediaDecodeTime must not become negative
  track.baseMediaDecodeTime = Math.max(0, track.baseMediaDecodeTime);

  if (track.type === 'audio') {
    // Audio has a different clock equal to the sampling_rate so we need to
    // scale the PTS values into the clock rate of the track
    scale = track.samplerate / oneSecondInPTS;
    track.baseMediaDecodeTime *= scale;
    track.baseMediaDecodeTime = Math.floor(track.baseMediaDecodeTime);
  }
};

/**
 * A Stream that can combine multiple streams (ie. audio & video)
 * into a single output segment for MSE. Also supports audio-only
 * and video-only streams.
 */
CoalesceStream = function(options, metadataStream) {
  // Number of Tracks per output segment
  // If greater than 1, we combine multiple
  // tracks into a single segment
  this.numberOfTracks = 0;
  this.metadataStream = metadataStream;

  if (typeof options.remux !== 'undefined') {
    this.remuxTracks = !!options.remux;
  } else {
    this.remuxTracks = true;
  }

  this.pendingTracks = [];
  this.videoTrack = null;
  this.pendingBoxes = [];
  this.pendingCaptions = [];
  this.pendingMetadata = [];
  this.pendingBytes = 0;
  this.emittedTracks = 0;

  CoalesceStream.prototype.init.call(this);

  // Take output from multiple
  this.push = function(output) {
    // buffer incoming captions until the associated video segment
    // finishes
    if (output.text) {
      return this.pendingCaptions.push(output);
    }
    // buffer incoming id3 tags until the final flush
    if (output.frames) {
      return this.pendingMetadata.push(output);
    }

    // Add this track to the list of pending tracks and store
    // important information required for the construction of
    // the final segment
    this.pendingTracks.push(output.track);
    this.pendingBoxes.push(output.boxes);
    this.pendingBytes += output.boxes.byteLength;

    if (output.track.type === 'video') {
      this.videoTrack = output.track;
    }
    if (output.track.type === 'audio') {
      this.audioTrack = output.track;
    }
  };
};

CoalesceStream.prototype = new Stream();
CoalesceStream.prototype.flush = function(flushSource) {
  var
    offset = 0,
    event = {
      captions: [],
      metadata: [],
      info: {}
    },
    caption,
    id3,
    initSegment,
    timelineStartPts = 0,
    i;

  if (this.pendingTracks.length < this.numberOfTracks) {
    if (flushSource !== 'VideoSegmentStream' &&
        flushSource !== 'AudioSegmentStream') {
      // Return because we haven't received a flush from a data-generating
      // portion of the segment (meaning that we have only recieved meta-data
      // or captions.)
      return;
    } else if (this.remuxTracks) {
      // Return until we have enough tracks from the pipeline to remux (if we
      // are remuxing audio and video into a single MP4)
      return;
    } else if (this.pendingTracks.length === 0) {
      // In the case where we receive a flush without any data having been
      // received we consider it an emitted track for the purposes of coalescing
      // `done` events.
      // We do this for the case where there is an audio and video track in the
      // segment but no audio data. (seen in several playlists with alternate
      // audio tracks and no audio present in the main TS segments.)
      this.emittedTracks++;

      if (this.emittedTracks >= this.numberOfTracks) {
        this.trigger('done');
        this.emittedTracks = 0;
      }
      return;
    }
  }

  if (this.videoTrack) {
    timelineStartPts = this.videoTrack.timelineStartInfo.pts;
    VIDEO_PROPERTIES.forEach(function(prop) {
      event.info[prop] = this.videoTrack[prop];
    }, this);
  } else if (this.audioTrack) {
    timelineStartPts = this.audioTrack.timelineStartInfo.pts;
    AUDIO_PROPERTIES.forEach(function(prop) {
      event.info[prop] = this.audioTrack[prop];
    }, this);
  }

  if (this.pendingTracks.length === 1) {
    event.type = this.pendingTracks[0].type;
  } else {
    event.type = 'combined';
  }

  this.emittedTracks += this.pendingTracks.length;

  initSegment = mp4.initSegment(this.pendingTracks);

  // Create a new typed array large enough to hold the init
  // segment and all tracks
  event.data = new Uint8Array(initSegment.byteLength +
                              this.pendingBytes);

  // Create an init segment containing a moov
  // and track definitions
  event.data.set(initSegment);
  offset += initSegment.byteLength;

  // Append each moof+mdat (one per track) after the init segment
  for (i = 0; i < this.pendingBoxes.length; i++) {
    event.data.set(this.pendingBoxes[i], offset);
    offset += this.pendingBoxes[i].byteLength;
  }

  // Translate caption PTS times into second offsets into the
  // video timeline for the segment
  for (i = 0; i < this.pendingCaptions.length; i++) {
    caption = this.pendingCaptions[i];
    caption.startTime = (caption.startPts - timelineStartPts);
    caption.startTime /= 90e3;
    caption.endTime = (caption.endPts - timelineStartPts);
    caption.endTime /= 90e3;
    event.captions.push(caption);
  }

  // Translate ID3 frame PTS times into second offsets into the
  // video timeline for the segment
  for (i = 0; i < this.pendingMetadata.length; i++) {
    id3 = this.pendingMetadata[i];
    id3.cueTime = (id3.pts - timelineStartPts);
    id3.cueTime /= 90e3;
    event.metadata.push(id3);
  }
  // We add this to every single emitted segment even though we only need
  // it for the first
  event.metadata.dispatchType = this.metadataStream.dispatchType;

  // Reset stream state
  this.pendingTracks.length = 0;
  this.videoTrack = null;
  this.pendingBoxes.length = 0;
  this.pendingCaptions.length = 0;
  this.pendingBytes = 0;
  this.pendingMetadata.length = 0;

  // Emit the built segment
  this.trigger('data', event);

  // Only emit `done` if all tracks have been flushed and emitted
  if (this.emittedTracks >= this.numberOfTracks) {
    this.trigger('done');
    this.emittedTracks = 0;
  }
};
/**
 * A Stream that expects MP2T binary data as input and produces
 * corresponding media segments, suitable for use with Media Source
 * Extension (MSE) implementations that support the ISO BMFF byte
 * stream format, like Chrome.
 */
Transmuxer = function(options) {
  var
    self = this,
    hasFlushed = true,
    videoTrack,
    audioTrack;

  Transmuxer.prototype.init.call(this);

  options = options || {};
  this.baseMediaDecodeTime = options.baseMediaDecodeTime || 0;
  this.transmuxPipeline_ = {};

  this.setupAacPipeline = function() {
    var pipeline = {};
    this.transmuxPipeline_ = pipeline;

    pipeline.type = 'aac';
    pipeline.metadataStream = new m2ts.MetadataStream();

    // set up the parsing pipeline
    pipeline.aacStream = new AacStream();
    pipeline.adtsStream = new AdtsStream();
    pipeline.coalesceStream = new CoalesceStream(options, pipeline.metadataStream);
    pipeline.headOfPipeline = pipeline.aacStream;

    pipeline.aacStream.pipe(pipeline.adtsStream);
    pipeline.aacStream.pipe(pipeline.metadataStream);
    pipeline.metadataStream.pipe(pipeline.coalesceStream);

    pipeline.metadataStream.on('timestamp', function(frame) {
      pipeline.aacStream.setTimestamp(frame.timeStamp);
    });

    pipeline.aacStream.on('data', function(data) {
      var i;

      if (data.type === 'timed-metadata' && !pipeline.audioSegmentStream) {
        audioTrack = audioTrack || {
          timelineStartInfo: {
            baseMediaDecodeTime: self.baseMediaDecodeTime
          },
          codec: 'adts',
          type: 'audio'
        };
        // hook up the audio segment stream to the first track with aac data
        pipeline.coalesceStream.numberOfTracks++;
        pipeline.audioSegmentStream = new AudioSegmentStream(audioTrack);
        // Set up the final part of the audio pipeline
        pipeline.adtsStream
          .pipe(pipeline.audioSegmentStream)
          .pipe(pipeline.coalesceStream);
      }
    });

    // Re-emit any data coming from the coalesce stream to the outside world
    pipeline.coalesceStream.on('data', this.trigger.bind(this, 'data'));
    // Let the consumer know we have finished flushing the entire pipeline
    pipeline.coalesceStream.on('done', this.trigger.bind(this, 'done'));
  };

  this.setupTsPipeline = function() {
    var pipeline = {};
    this.transmuxPipeline_ = pipeline;

    pipeline.type = 'ts';
    pipeline.metadataStream = new m2ts.MetadataStream();

    // set up the parsing pipeline
    pipeline.packetStream = new m2ts.TransportPacketStream();
    pipeline.parseStream = new m2ts.TransportParseStream();
    pipeline.elementaryStream = new m2ts.ElementaryStream();
    pipeline.adtsStream = new AdtsStream();
    pipeline.h264Stream = new H264Stream();
    pipeline.captionStream = new m2ts.CaptionStream();
    pipeline.coalesceStream = new CoalesceStream(options, pipeline.metadataStream);
    pipeline.headOfPipeline = pipeline.packetStream;

    // disassemble MPEG2-TS packets into elementary streams
    pipeline.packetStream
      .pipe(pipeline.parseStream)
      .pipe(pipeline.elementaryStream);

    // !!THIS ORDER IS IMPORTANT!!
    // demux the streams
    pipeline.elementaryStream
      .pipe(pipeline.h264Stream);
    pipeline.elementaryStream
      .pipe(pipeline.adtsStream);

    pipeline.elementaryStream
      .pipe(pipeline.metadataStream)
      .pipe(pipeline.coalesceStream);

    // Hook up CEA-608/708 caption stream
    pipeline.h264Stream.pipe(pipeline.captionStream)
      .pipe(pipeline.coalesceStream);

    pipeline.elementaryStream.on('data', function(data) {
      var i;

      if (data.type === 'metadata') {
        i = data.tracks.length;

        // scan the tracks listed in the metadata
        while (i--) {
          if (!videoTrack && data.tracks[i].type === 'video') {
            videoTrack = data.tracks[i];
            videoTrack.timelineStartInfo.baseMediaDecodeTime = self.baseMediaDecodeTime;
          } else if (!audioTrack && data.tracks[i].type === 'audio') {
            audioTrack = data.tracks[i];
            audioTrack.timelineStartInfo.baseMediaDecodeTime = self.baseMediaDecodeTime;
          }
        }

        // hook up the video segment stream to the first track with h264 data
        if (videoTrack && !pipeline.videoSegmentStream) {
          pipeline.coalesceStream.numberOfTracks++;
          pipeline.videoSegmentStream = new VideoSegmentStream(videoTrack);

          pipeline.videoSegmentStream.on('timelineStartInfo', function(timelineStartInfo){
          // When video emits timelineStartInfo data after a flush, we forward that
          // info to the AudioSegmentStream, if it exists, because video timeline
          // data takes precedence.
            if (audioTrack) {
              audioTrack.timelineStartInfo = timelineStartInfo;
              // On the first segment we trim AAC frames that exist before the
              // very earliest DTS we have seen in video because Chrome will
              // interpret any video track with a baseMediaDecodeTime that is
              // non-zero as a gap.
              pipeline.audioSegmentStream.setEarliestDts(timelineStartInfo.dts);
            }
          });

          // Set up the final part of the video pipeline
          pipeline.h264Stream
            .pipe(pipeline.videoSegmentStream)
            .pipe(pipeline.coalesceStream);
        }

        if (audioTrack && !pipeline.audioSegmentStream) {
          // hook up the audio segment stream to the first track with aac data
          pipeline.coalesceStream.numberOfTracks++;
          pipeline.audioSegmentStream = new AudioSegmentStream(audioTrack);

          // Set up the final part of the audio pipeline
          pipeline.adtsStream
            .pipe(pipeline.audioSegmentStream)
            .pipe(pipeline.coalesceStream);
        }
      }
    });

    // Re-emit any data coming from the coalesce stream to the outside world
    pipeline.coalesceStream.on('data', this.trigger.bind(this, 'data'));
    // Let the consumer know we have finished flushing the entire pipeline
    pipeline.coalesceStream.on('done', this.trigger.bind(this, 'done'));
  };

  // hook up the segment streams once track metadata is delivered
  this.setBaseMediaDecodeTime = function (baseMediaDecodeTime) {
    var pipeline = this.transmuxPipeline_;

    this.baseMediaDecodeTime = baseMediaDecodeTime;
    if (audioTrack) {
      audioTrack.timelineStartInfo.dts = undefined;
      audioTrack.timelineStartInfo.pts = undefined;
      clearDtsInfo(audioTrack);
      audioTrack.timelineStartInfo.baseMediaDecodeTime = baseMediaDecodeTime;
    }
    if (videoTrack) {
      if (pipeline.videoSegmentStream) {
        pipeline.videoSegmentStream.gopCache_ = [];
      }
      videoTrack.timelineStartInfo.dts = undefined;
      videoTrack.timelineStartInfo.pts = undefined;
      clearDtsInfo(videoTrack);
      videoTrack.timelineStartInfo.baseMediaDecodeTime = baseMediaDecodeTime;
    }
  };

  // feed incoming data to the front of the parsing pipeline
  this.push = function(data) {
    if (hasFlushed) {
      var isAac = isLikelyAacData(data);

      if (isAac && this.transmuxPipeline_.type !== 'aac') {
        this.setupAacPipeline();
      } else if (!isAac && this.transmuxPipeline_.type !== 'ts') {
        this.setupTsPipeline();
      }
      hasFlushed = false;
    }
    this.transmuxPipeline_.headOfPipeline.push(data);
  };

  // flush any buffered data
  this.flush = function() {
      hasFlushed = true;
    // Start at the top of the pipeline and flush all pending work
    this.transmuxPipeline_.headOfPipeline.flush();
  };
};
Transmuxer.prototype = new Stream();

module.exports = {
  Transmuxer: Transmuxer,
  VideoSegmentStream: VideoSegmentStream,
  AudioSegmentStream: AudioSegmentStream,
  AUDIO_PROPERTIES: AUDIO_PROPERTIES,
  VIDEO_PROPERTIES: VIDEO_PROPERTIES
};

},{"../aac":1,"../codecs/adts.js":2,"../codecs/h264":3,"../m2ts/m2ts.js":11,"../utils/stream.js":20,"./mp4-generator.js":15}],17:[function(require,module,exports){
'use strict';

var
  tagTypes = {
    0x08: 'audio',
    0x09: 'video',
    0x12: 'metadata'
  },
  hex = function (val) {
    return '0x' + ('00' + val.toString(16)).slice(-2).toUpperCase();
  },
  hexStringList = function (data) {
    var arr = [], i;
    /* jshint -W086 */
    while(data.byteLength > 0) {
      i = 0;
      switch(data.byteLength) {
        default:
          arr.push(hex(data[i++]));
        case 7:
          arr.push(hex(data[i++]));
        case 6:
          arr.push(hex(data[i++]));
        case 5:
          arr.push(hex(data[i++]));
        case 4:
          arr.push(hex(data[i++]));
        case 3:
          arr.push(hex(data[i++]));
        case 2:
          arr.push(hex(data[i++]));
        case 1:
          arr.push(hex(data[i++]));
      }
      data = data.subarray(i);
    }
    /* jshint +W086 */
    return arr.join(' ');
  },
  parseAVCTag = function (tag, obj) {
    var
      avcPacketTypes = [
        'AVC Sequence Header',
        'AVC NALU',
        'AVC End-of-Sequence'
      ],
      nalUnitTypes = [
        'unspecified',
        'slice_layer_without_partitioning',
        'slice_data_partition_a_layer',
        'slice_data_partition_b_layer',
        'slice_data_partition_c_layer',
        'slice_layer_without_partitioning_idr',
        'sei',
        'seq_parameter_set',
        'pic_parameter_set',
        'access_unit_delimiter',
        'end_of_seq',
        'end_of_stream',
        'filler',
        'seq_parameter_set_ext',
        'prefix_nal_unit',
        'subset_seq_parameter_set',
        'reserved',
        'reserved',
        'reserved'
      ],
      compositionTime = (tag[1] & parseInt('01111111', 2) << 16) | (tag[2] << 8) | tag[3];

    obj = obj || {};

    obj.avcPacketType = avcPacketTypes[tag[0]];
    obj.CompositionTime = (tag[1] & parseInt('10000000', 2)) ? -compositionTime : compositionTime;

    if (tag[0] === 1) {
      obj.nalUnitTypeRaw = hexStringList(tag.subarray(4, 100));
    } else {
      obj.data = hexStringList(tag.subarray(4));
    }

    return obj;
  },
  parseVideoTag = function (tag, obj) {
    var
      frameTypes = [
        'Unknown',
        'Keyframe (for AVC, a seekable frame)',
        'Inter frame (for AVC, a nonseekable frame)',
        'Disposable inter frame (H.263 only)',
        'Generated keyframe (reserved for server use only)',
        'Video info/command frame'
      ],
      codecIDs = [
        'JPEG (currently unused)',
        'Sorenson H.263',
        'Screen video',
        'On2 VP6',
        'On2 VP6 with alpha channel',
        'Screen video version 2',
        'AVC'
      ],
      codecID = tag[0] & parseInt('00001111', 2);

    obj = obj || {};

    obj.frameType = frameTypes[(tag[0] & parseInt('11110000', 2)) >>> 4];
    obj.codecID = codecID;

    if (codecID === 7) {
      return parseAVCTag(tag.subarray(1), obj);
    }
    return obj;
  },
  parseAACTag = function (tag, obj) {
    var packetTypes = [
      'AAC Sequence Header',
      'AAC Raw'
    ];

    obj = obj || {};

    obj.aacPacketType = packetTypes[tag[0]];
    obj.data = hexStringList(tag.subarray(1));

    return obj;
  },
  parseAudioTag = function (tag, obj) {
    var
      formatTable = [
        'Linear PCM, platform endian',
        'ADPCM',
        'MP3',
        'Linear PCM, little endian',
        'Nellymoser 16-kHz mono',
        'Nellymoser 8-kHz mono',
        'Nellymoser',
        'G.711 A-law logarithmic PCM',
        'G.711 mu-law logarithmic PCM',
        'reserved',
        'AAC',
        'Speex',
        'MP3 8-Khz',
        'Device-specific sound'
      ],
      samplingRateTable = [
        '5.5-kHz',
        '11-kHz',
        '22-kHz',
        '44-kHz'
      ],
      soundFormat = (tag[0] & parseInt('11110000', 2)) >>> 4;

    obj = obj || {};

    obj.soundFormat = formatTable[soundFormat];
    obj.soundRate = samplingRateTable[(tag[0] & parseInt('00001100', 2)) >>> 2];
    obj.soundSize = ((tag[0] & parseInt('00000010', 2)) >>> 1) ? '16-bit' : '8-bit';
    obj.soundType = (tag[0] & parseInt('00000001', 2)) ? 'Stereo' : 'Mono';

    if (soundFormat === 10) {
      return parseAACTag(tag.subarray(1), obj);
    }
    return obj;
  },
  parseGenericTag = function (tag) {
    return {
      tagType: tagTypes[tag[0]],
      dataSize: (tag[1] << 16) | (tag[2] << 8) | tag[3],
      timestamp: (tag[7] << 24) | (tag[4] << 16) | (tag[5] << 8) | tag[6],
      streamID: (tag[8] << 16) | (tag[9] << 8) | tag[10]
    };
  },
  inspectFlvTag = function (tag) {
    var header = parseGenericTag(tag);
    switch (tag[0]) {
      case 0x08:
        parseAudioTag(tag.subarray(11), header);
        break;
      case 0x09:
        parseVideoTag(tag.subarray(11), header);
        break;
      case 0x12:
    }
    return header;
  },
  inspectFlv = function (bytes) {
    var i = 9, // header
        dataSize,
        parsedResults = [],
        tag;

    // traverse the tags
    i += 4; // skip previous tag size
    while (i < bytes.byteLength) {
      dataSize = bytes[i + 1] << 16;
      dataSize |= bytes[i + 2] << 8;
      dataSize |= bytes[i + 3];
      dataSize += 11;

      tag = bytes.subarray(i, i + dataSize);
      parsedResults.push(inspectFlvTag(tag));
      i += dataSize + 4;
    }
    return parsedResults;
  },
  textifyFlv = function (flvTagArray) {
    return JSON.stringify(flvTagArray, null, 2);
  };

module.exports = {
  inspectTag: inspectFlvTag,
  inspect: inspectFlv,
  textify: textifyFlv
};

},{}],18:[function(require,module,exports){
(function (global){
'use strict';

var
  inspectMp4,
  textifyMp4,
  /**
   * Returns the string representation of an ASCII encoded four byte buffer.
   * @param buffer {Uint8Array} a four-byte buffer to translate
   * @return {string} the corresponding string
   */
  parseType = function(buffer) {
    var result = '';
    result += String.fromCharCode(buffer[0]);
    result += String.fromCharCode(buffer[1]);
    result += String.fromCharCode(buffer[2]);
    result += String.fromCharCode(buffer[3]);
    return result;
  },
  parseMp4Date = function(seconds) {
    return new Date(seconds * 1000 - 2082844800000);
  },
  parseSampleFlags = function(flags) {
    return {
      isLeading: (flags[0] & 0x0c) >>> 2,
      dependsOn: flags[0] & 0x03,
      isDependedOn: (flags[1] & 0xc0) >>> 6,
      hasRedundancy: (flags[1] & 0x30) >>> 4,
      paddingValue: (flags[1] & 0x0e) >>> 1,
      isNonSyncSample: flags[1] & 0x01,
      degradationPriority: (flags[2] << 8) | flags[3]
    };
  },
  nalParse = function(avcStream) {
    var
      avcView = new DataView(avcStream.buffer, avcStream.byteOffset, avcStream.byteLength),
      result = [],
      i,
      length;
    for (i = 0; i + 4 < avcStream.length; i += length) {
      length = avcView.getUint32(i);
      i += 4;

      // bail if this doesn't appear to be an H264 stream
      if (length <= 0) {
        result.push('<span style=\'color:red;\'>MALFORMED DATA</span>');
        continue;
      }

      switch(avcStream[i] & 0x1F) {
      case 0x01:
        result.push('slice_layer_without_partitioning_rbsp');
        break;
      case 0x05:
        result.push('slice_layer_without_partitioning_rbsp_idr');
        break;
      case 0x06:
        result.push('sei_rbsp');
        break;
      case 0x07:
        result.push('seq_parameter_set_rbsp');
        break;
      case 0x08:
        result.push('pic_parameter_set_rbsp');
        break;
      case 0x09:
        result.push('access_unit_delimiter_rbsp');
        break;
      default:
        result.push('UNKNOWN NAL - ' + avcStream[i] & 0x1F);
        break;
      }
    }
    return result;
  },

  // registry of handlers for individual mp4 box types
  parse = {
    // codingname, not a first-class box type. stsd entries share the
    // same format as real boxes so the parsing infrastructure can be
    // shared
    avc1: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        dataReferenceIndex: view.getUint16(6),
        width:  view.getUint16(24),
        height: view.getUint16(26),
        horizresolution: view.getUint16(28) + (view.getUint16(30) / 16),
        vertresolution: view.getUint16(32) + (view.getUint16(34) / 16),
        frameCount: view.getUint16(40),
        depth: view.getUint16(74),
        config: inspectMp4(data.subarray(78, data.byteLength))
      };
    },
    avcC: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          configurationVersion: data[0],
          avcProfileIndication: data[1],
          profileCompatibility: data[2],
          avcLevelIndication: data[3],
          lengthSizeMinusOne: data[4] & 0x03,
          sps: [],
          pps: []
        },
        numOfSequenceParameterSets = data[5] & 0x1f,
        numOfPictureParameterSets,
        nalSize,
        offset,
        i;

      // iterate past any SPSs
      offset = 6;
      for (i = 0; i < numOfSequenceParameterSets; i++) {
        nalSize = view.getUint16(offset);
        offset += 2;
        result.sps.push(new Uint8Array(data.subarray(offset, offset + nalSize)));
        offset += nalSize;
      }
      // iterate past any PPSs
      numOfPictureParameterSets = data[offset];
      offset++;
      for (i = 0; i < numOfPictureParameterSets; i++) {
        nalSize = view.getUint16(offset);
        offset += 2;
        result.pps.push(new Uint8Array(data.subarray(offset, offset + nalSize)));
        offset += nalSize;
      }
      return result;
    },
    btrt: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        bufferSizeDB: view.getUint32(0),
        maxBitrate: view.getUint32(4),
        avgBitrate: view.getUint32(8)
      };
    },
    esds: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        esId: (data[6] << 8) | data[7],
        streamPriority: data[8] & 0x1f,
        decoderConfig: {
          objectProfileIndication: data[11],
          streamType: (data[12] >>> 2) & 0x3f,
          bufferSize: (data[13] << 16) | (data[14] << 8) | data[15],
          maxBitrate: (data[16] << 24) |
            (data[17] << 16) |
            (data[18] <<  8) |
            data[19],
          avgBitrate: (data[20] << 24) |
            (data[21] << 16) |
            (data[22] <<  8) |
            data[23],
          decoderConfigDescriptor: {
            tag: data[24],
            length: data[25],
            audioObjectType: (data[26] >>> 3) & 0x1f,
            samplingFrequencyIndex: ((data[26] & 0x07) << 1) |
              ((data[27] >>> 7) & 0x01),
            channelConfiguration: (data[27] >>> 3) & 0x0f
          }
        }
      };
    },
    ftyp: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          majorBrand: parseType(data.subarray(0, 4)),
          minorVersion: view.getUint32(4),
          compatibleBrands: []
        },
        i = 8;
      while (i < data.byteLength) {
        result.compatibleBrands.push(parseType(data.subarray(i, i + 4)));
        i += 4;
      }
      return result;
    },
    dinf: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    dref: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        dataReferences: inspectMp4(data.subarray(8))
      };
    },
    hdlr: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        language,
        result = {
          version: view.getUint8(0),
          flags: new Uint8Array(data.subarray(1, 4)),
          handlerType: parseType(data.subarray(8, 12)),
          name: ''
        },
        i = 8;

      // parse out the name field
      for (i = 24; i < data.byteLength; i++) {
        if (data[i] === 0x00) {
          // the name field is null-terminated
          i++;
          break;
        }
        result.name += String.fromCharCode(data[i]);
      }
      // decode UTF-8 to javascript's internal representation
      // see http://ecmanaut.blogspot.com/2006/07/encoding-decoding-utf8-in-javascript.html
      result.name = decodeURIComponent(global.escape(result.name));

      return result;
    },
    mdat: function(data) {
      return {
        byteLength: data.byteLength,
        nals: nalParse(data)
      };
    },
    mdhd: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        i = 4,
        language,
        result = {
          version: view.getUint8(0),
          flags: new Uint8Array(data.subarray(1, 4)),
          language: ''
        };
      if (result.version === 1) {
        i += 4;
        result.creationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 8;
        result.modificationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 4;
        result.timescale = view.getUint32(i);
        i += 8;
        result.duration = view.getUint32(i); // truncating top 4 bytes
      } else {
        result.creationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.modificationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.timescale = view.getUint32(i);
        i += 4;
        result.duration = view.getUint32(i);
      }
      i += 4;
      // language is stored as an ISO-639-2/T code in an array of three 5-bit fields
      // each field is the packed difference between its ASCII value and 0x60
      language = view.getUint16(i);
      result.language += String.fromCharCode((language >> 10) + 0x60);
      result.language += String.fromCharCode(((language & 0x03c0) >> 5) + 0x60);
      result.language += String.fromCharCode((language & 0x1f) + 0x60);

      return result;
    },
    mdia: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    mfhd: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        sequenceNumber: (data[4] << 24) |
          (data[5] << 16) |
          (data[6] << 8) |
          (data[7])
      };
    },
    minf: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    // codingname, not a first-class box type. stsd entries share the
    // same format as real boxes so the parsing infrastructure can be
    // shared
    mp4a: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          // 6 bytes reserved
          dataReferenceIndex: view.getUint16(6),
          // 4 + 4 bytes reserved
          channelcount: view.getUint16(16),
          samplesize: view.getUint16(18),
          // 2 bytes pre_defined
          // 2 bytes reserved
          samplerate: view.getUint16(24) + (view.getUint16(26) / 65536)
        };

      // if there are more bytes to process, assume this is an ISO/IEC
      // 14496-14 MP4AudioSampleEntry and parse the ESDBox
      if (data.byteLength > 28) {
        result.streamDescriptor = inspectMp4(data.subarray(28))[0];
      }
      return result;
    },
    moof: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    moov: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    mvex: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    mvhd: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        i = 4,
        result = {
          version: view.getUint8(0),
          flags: new Uint8Array(data.subarray(1, 4))
        };

      if (result.version === 1) {
        i += 4;
        result.creationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 8;
        result.modificationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 4;
        result.timescale = view.getUint32(i);
        i += 8;
        result.duration = view.getUint32(i); // truncating top 4 bytes
      } else {
        result.creationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.modificationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.timescale = view.getUint32(i);
        i += 4;
        result.duration = view.getUint32(i);
      }
      i += 4;

      // convert fixed-point, base 16 back to a number
      result.rate = view.getUint16(i) + (view.getUint16(i + 2) / 16);
      i += 4;
      result.volume = view.getUint8(i) + (view.getUint8(i + 1) / 8);
      i += 2;
      i += 2;
      i += 2 * 4;
      result.matrix = new Uint32Array(data.subarray(i, i + (9 * 4)));
      i += 9 * 4;
      i += 6 * 4;
      result.nextTrackId = view.getUint32(i);
      return result;
    },
    pdin: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        version: view.getUint8(0),
        flags: new Uint8Array(data.subarray(1, 4)),
        rate: view.getUint32(4),
        initialDelay: view.getUint32(8)
      };
    },
    sdtp: function(data) {
      var
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          samples: []
        }, i;

      for (i = 4; i < data.byteLength; i++) {
        result.samples.push({
          dependsOn: (data[i] & 0x30) >> 4,
          isDependedOn: (data[i] & 0x0c) >> 2,
          hasRedundancy: data[i] & 0x03
        });
      }
      return result;
    },
    sidx: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength),
          result = {
            version: data[0],
            flags: new Uint8Array(data.subarray(1, 4)),
            references: [],
            referenceId: view.getUint32(4),
            timescale: view.getUint32(8),
            earliestPresentationTime: view.getUint32(12),
            firstOffset: view.getUint32(16)
          },
          referenceCount = view.getUint16(22),
          i;

      for (i = 24; referenceCount; i += 12, referenceCount-- ) {
        result.references.push({
          referenceType: (data[i] & 0x80) >>> 7,
          referencedSize: view.getUint32(i) & 0x7FFFFFFF,
          subsegmentDuration: view.getUint32(i + 4),
          startsWithSap: !!(data[i + 8] & 0x80),
          sapType: (data[i + 8] & 0x70) >>> 4,
          sapDeltaTime: view.getUint32(i + 8) & 0x0FFFFFFF
        });
      }

      return result;
    },
    smhd: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        balance: data[4] + (data[5] / 256)
      };
    },
    stbl: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    stco: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          chunkOffsets: []
        },
        entryCount = view.getUint32(4),
        i;
      for (i = 8; entryCount; i += 4, entryCount--) {
        result.chunkOffsets.push(view.getUint32(i));
      }
      return result;
    },
    stsc: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        entryCount = view.getUint32(4),
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          sampleToChunks: []
        },
        i;
      for (i = 8; entryCount; i += 12, entryCount--) {
        result.sampleToChunks.push({
          firstChunk: view.getUint32(i),
          samplesPerChunk: view.getUint32(i + 4),
          sampleDescriptionIndex: view.getUint32(i + 8)
        });
      }
      return result;
    },
    stsd: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        sampleDescriptions: inspectMp4(data.subarray(8))
      };
    },
    stsz: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          sampleSize: view.getUint32(4),
          entries: []
        },
        i;
      for (i = 12; i < data.byteLength; i += 4) {
        result.entries.push(view.getUint32(i));
      }
      return result;
    },
    stts: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          timeToSamples: []
        },
        entryCount = view.getUint32(4),
        i;

      for (i = 8; entryCount; i += 8, entryCount--) {
        result.timeToSamples.push({
          sampleCount: view.getUint32(i),
          sampleDelta: view.getUint32(i + 4)
        });
      }
      return result;
    },
    styp: function(data) {
      return parse.ftyp(data);
    },
    tfdt: function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        baseMediaDecodeTime: data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]
      };
    },
    tfhd: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          trackId: view.getUint32(4)
        },
        baseDataOffsetPresent = result.flags[2] & 0x01,
        sampleDescriptionIndexPresent = result.flags[2] & 0x02,
        defaultSampleDurationPresent = result.flags[2] & 0x08,
        defaultSampleSizePresent = result.flags[2] & 0x10,
        defaultSampleFlagsPresent = result.flags[2] & 0x20,
        i;

      i = 8;
      if (baseDataOffsetPresent) {
        i += 4; // truncate top 4 bytes
        result.baseDataOffset = view.getUint32(12);
        i += 4;
      }
      if (sampleDescriptionIndexPresent) {
        result.sampleDescriptionIndex = view.getUint32(i);
        i += 4;
      }
      if (defaultSampleDurationPresent) {
        result.defaultSampleDuration = view.getUint32(i);
        i += 4;
      }
      if (defaultSampleSizePresent) {
        result.defaultSampleSize = view.getUint32(i);
        i += 4;
      }
      if (defaultSampleFlagsPresent) {
        result.defaultSampleFlags = view.getUint32(i);
      }
      return result;
    },
    tkhd: function(data) {
      var
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        i = 4,
        result = {
          version: view.getUint8(0),
          flags: new Uint8Array(data.subarray(1, 4)),
        };
      if (result.version === 1) {
        i += 4;
        result.creationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 8;
        result.modificationTime = parseMp4Date(view.getUint32(i)); // truncating top 4 bytes
        i += 4;
        result.trackId = view.getUint32(i);
        i += 4;
        i += 8;
        result.duration = view.getUint32(i); // truncating top 4 bytes
      } else {
        result.creationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.modificationTime = parseMp4Date(view.getUint32(i));
        i += 4;
        result.trackId = view.getUint32(i);
        i += 4;
        i += 4;
        result.duration = view.getUint32(i);
      }
      i += 4;
      i += 2 * 4;
      result.layer = view.getUint16(i);
      i += 2;
      result.alternateGroup = view.getUint16(i);
      i += 2;
      // convert fixed-point, base 16 back to a number
      result.volume = view.getUint8(i) + (view.getUint8(i + 1) / 8);
      i += 2;
      i += 2;
      result.matrix = new Uint32Array(data.subarray(i, i + (9 * 4)));
      i += 9 * 4;
      result.width = view.getUint16(i) + (view.getUint16(i + 2) / 16);
      i += 4;
      result.height = view.getUint16(i) + (view.getUint16(i + 2) / 16);
      return result;
    },
    traf: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    trak: function(data) {
      return {
        boxes: inspectMp4(data)
      };
    },
    trex: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        trackId: view.getUint32(4),
        defaultSampleDescriptionIndex: view.getUint32(8),
        defaultSampleDuration: view.getUint32(12),
        defaultSampleSize: view.getUint32(16),
        sampleDependsOn: data[20] & 0x03,
        sampleIsDependedOn: (data[21] & 0xc0) >> 6,
        sampleHasRedundancy: (data[21] & 0x30) >> 4,
        samplePaddingValue: (data[21] & 0x0e) >> 1,
        sampleIsDifferenceSample: !!(data[21] & 0x01),
        sampleDegradationPriority: view.getUint16(22)
      };
    },
    trun: function(data) {
      var
        result = {
          version: data[0],
          flags: new Uint8Array(data.subarray(1, 4)),
          samples: []
        },
        view = new DataView(data.buffer, data.byteOffset, data.byteLength),
        dataOffsetPresent = result.flags[2] & 0x01,
        firstSampleFlagsPresent = result.flags[2] & 0x04,
        sampleDurationPresent = result.flags[1] & 0x01,
        sampleSizePresent = result.flags[1] & 0x02,
        sampleFlagsPresent = result.flags[1] & 0x04,
        sampleCompositionTimeOffsetPresent = result.flags[1] & 0x08,
        sampleCount = view.getUint32(4),
        offset = 8,
        sample;

      if (dataOffsetPresent) {
        result.dataOffset = view.getUint32(offset);
        offset += 4;
      }

      if (firstSampleFlagsPresent && sampleCount) {
        sample = {
          flags: parseSampleFlags(data.subarray(offset, offset + 4))
        };
        offset += 4;
        if (sampleDurationPresent) {
          sample.duration = view.getUint32(offset);
          offset += 4;
        }
        if (sampleSizePresent) {
          sample.size = view.getUint32(offset);
          offset += 4;
        }
        if (sampleCompositionTimeOffsetPresent) {
          sample.compositionTimeOffset = view.getUint32(offset);
          offset += 4;
        }
        result.samples.push(sample);
        sampleCount--;
      }

      while (sampleCount--) {
        sample = {};
        if (sampleDurationPresent) {
          sample.duration = view.getUint32(offset);
          offset += 4;
        }
        if (sampleSizePresent) {
          sample.size = view.getUint32(offset);
          offset += 4;
        }
        if (sampleFlagsPresent) {
          sample.flags = parseSampleFlags(data.subarray(offset, offset + 4));
          offset += 4;
        }
        if (sampleCompositionTimeOffsetPresent) {
          sample.compositionTimeOffset = view.getUint32(offset);
          offset += 4;
        }
        result.samples.push(sample);
      }
      return result;
    },
    'url ': function(data) {
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4))
      };
    },
    vmhd: function(data) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        version: data[0],
        flags: new Uint8Array(data.subarray(1, 4)),
        graphicsmode: view.getUint16(4),
        opcolor: new Uint16Array([view.getUint16(6),
                                  view.getUint16(8),
                                  view.getUint16(10)])
      };
    }
  };


/**
 * Return a javascript array of box objects parsed from an ISO base
 * media file.
 * @param data {Uint8Array} the binary data of the media to be inspected
 * @return {array} a javascript array of potentially nested box objects
 */
inspectMp4 = function(data) {
  var
    i = 0,
    result = [],
    view,
    size,
    type,
    end,
    box;

  // Convert data from Uint8Array to ArrayBuffer, to follow Dataview API
  var ab = new ArrayBuffer(data.length);
  var v = new Uint8Array(ab);
  for (var z = 0; z < data.length; ++z) {
      v[z] = data[z];
  }
  view = new DataView(ab);


  while (i < data.byteLength) {
    // parse box data
    size = view.getUint32(i);
    type =  parseType(data.subarray(i + 4, i + 8));
    end = size > 1 ? i + size : data.byteLength;

    // parse type-specific data
    box = (parse[type] || function(data) {
      return {
        data: data
      };
    })(data.subarray(i + 8, end));
    box.size = size;
    box.type = type;

    // store this box and move to the next
    result.push(box);
    i = end;
  }
  return result;
};

/**
 * Returns a textual representation of the javascript represtentation
 * of an MP4 file. You can use it as an alternative to
 * JSON.stringify() to compare inspected MP4s.
 * @param inspectedMp4 {array} the parsed array of boxes in an MP4
 * file
 * @param depth {number} (optional) the number of ancestor boxes of
 * the elements of inspectedMp4. Assumed to be zero if unspecified.
 * @return {string} a text representation of the parsed MP4
 */
textifyMp4 = function(inspectedMp4, depth) {
  var indent;
  depth = depth || 0;
  indent = new Array(depth * 2 + 1).join(' ');

  // iterate over all the boxes
  return inspectedMp4.map(function(box, index) {

    // list the box type first at the current indentation level
    return indent + box.type + '\n' +

      // the type is already included and handle child boxes separately
      Object.keys(box).filter(function(key) {
        return key !== 'type' && key !== 'boxes';

      // output all the box properties
      }).map(function(key) {
        var prefix = indent + '  ' + key + ': ',
            value = box[key];

        // print out raw bytes as hexademical
        if (value instanceof Uint8Array || value instanceof Uint32Array) {
          var bytes = Array.prototype.slice.call(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
              .map(function(byte) {
                return ' ' + ('00' + byte.toString(16)).slice(-2);
              }).join('').match(/.{1,24}/g);
          if (!bytes) {
            return prefix + '<>';
          }
          if (bytes.length === 1) {
            return prefix + '<' + bytes.join('').slice(1) + '>';
          }
          return prefix + '<\n' + bytes.map(function(line) {
            return indent + '  ' + line;
          }).join('\n') + '\n' + indent + '  >';
        }

        // stringify generic objects
        return prefix +
            JSON.stringify(value, null, 2)
              .split('\n').map(function(line, index) {
                if (index === 0) {
                  return line;
                }
                return indent + '  ' + line;
              }).join('\n');
      }).join('\n') +

    // recursively textify the child boxes
    (box.boxes ? '\n' + textifyMp4(box.boxes, depth + 1) : '');
  }).join('\n');
};

module.exports = {
  inspect: inspectMp4,
  textify: textifyMp4
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],19:[function(require,module,exports){
'use strict';

var ExpGolomb;

/**
 * Parser for exponential Golomb codes, a variable-bitwidth number encoding
 * scheme used by h264.
 */
ExpGolomb = function(workingData) {
  var
    // the number of bytes left to examine in workingData
    workingBytesAvailable = workingData.byteLength,

    // the current word being examined
    workingWord = 0, // :uint

    // the number of bits left to examine in the current word
    workingBitsAvailable = 0; // :uint;

  // ():uint
  this.length = function() {
    return (8 * workingBytesAvailable);
  };

  // ():uint
  this.bitsAvailable = function() {
    return (8 * workingBytesAvailable) + workingBitsAvailable;
  };

  // ():void
  this.loadWord = function() {
    var
      position = workingData.byteLength - workingBytesAvailable,
      workingBytes = new Uint8Array(4),
      availableBytes = Math.min(4, workingBytesAvailable);

    if (availableBytes === 0) {
      throw new Error('no bytes available');
    }

    workingBytes.set(workingData.subarray(position,
                                          position + availableBytes));
    workingWord = new DataView(workingBytes.buffer).getUint32(0);

    // track the amount of workingData that has been processed
    workingBitsAvailable = availableBytes * 8;
    workingBytesAvailable -= availableBytes;
  };

  // (count:int):void
  this.skipBits = function(count) {
    var skipBytes; // :int
    if (workingBitsAvailable > count) {
      workingWord          <<= count;
      workingBitsAvailable -= count;
    } else {
      count -= workingBitsAvailable;
      skipBytes = Math.floor(count / 8);

      count -= (skipBytes * 8);
      workingBytesAvailable -= skipBytes;

      this.loadWord();

      workingWord <<= count;
      workingBitsAvailable -= count;
    }
  };

  // (size:int):uint
  this.readBits = function(size) {
    var
      bits = Math.min(workingBitsAvailable, size), // :uint
      valu = workingWord >>> (32 - bits); // :uint
    // if size > 31, handle error
    workingBitsAvailable -= bits;
    if (workingBitsAvailable > 0) {
      workingWord <<= bits;
    } else if (workingBytesAvailable > 0) {
      this.loadWord();
    }

    bits = size - bits;
    if (bits > 0) {
      return valu << bits | this.readBits(bits);
    } else {
      return valu;
    }
  };

  // ():uint
  this.skipLeadingZeros = function() {
    var leadingZeroCount; // :uint
    for (leadingZeroCount = 0 ; leadingZeroCount < workingBitsAvailable ; ++leadingZeroCount) {
      if (0 !== (workingWord & (0x80000000 >>> leadingZeroCount))) {
        // the first bit of working word is 1
        workingWord <<= leadingZeroCount;
        workingBitsAvailable -= leadingZeroCount;
        return leadingZeroCount;
      }
    }

    // we exhausted workingWord and still have not found a 1
    this.loadWord();
    return leadingZeroCount + this.skipLeadingZeros();
  };

  // ():void
  this.skipUnsignedExpGolomb = function() {
    this.skipBits(1 + this.skipLeadingZeros());
  };

  // ():void
  this.skipExpGolomb = function() {
    this.skipBits(1 + this.skipLeadingZeros());
  };

  // ():uint
  this.readUnsignedExpGolomb = function() {
    var clz = this.skipLeadingZeros(); // :uint
    return this.readBits(clz + 1) - 1;
  };

  // ():int
  this.readExpGolomb = function() {
    var valu = this.readUnsignedExpGolomb(); // :int
    if (0x01 & valu) {
      // the number is odd if the low order bit is set
      return (1 + valu) >>> 1; // add 1 to make it even, and divide by 2
    } else {
      return -1 * (valu >>> 1); // divide by two then make it negative
    }
  };

  // Some convenience functions
  // :Boolean
  this.readBoolean = function() {
    return 1 === this.readBits(1);
  };

  // ():int
  this.readUnsignedByte = function() {
    return this.readBits(8);
  };

  this.loadWord();
};

module.exports = ExpGolomb;

},{}],20:[function(require,module,exports){
/**
 * mux.js
 *
 * Copyright (c) 2014 Brightcove
 * All rights reserved.
 *
 * A lightweight readable stream implemention that handles event dispatching.
 * Objects that inherit from streams should call init in their constructors.
 */
'use strict';

var Stream = function() {
  this.init = function() {
    var listeners = {};
    /**
     * Add a listener for a specified event type.
     * @param type {string} the event name
     * @param listener {function} the callback to be invoked when an event of
     * the specified type occurs
     */
    this.on = function(type, listener) {
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(listener);
    };
    /**
     * Remove a listener for a specified event type.
     * @param type {string} the event name
     * @param listener {function} a function previously registered for this
     * type of event through `on`
     */
    this.off = function(type, listener) {
      var index;
      if (!listeners[type]) {
        return false;
      }
      index = listeners[type].indexOf(listener);
      listeners[type].splice(index, 1);
      return index > -1;
    };
    /**
     * Trigger an event of the specified type on this stream. Any additional
     * arguments to this function are passed as parameters to event listeners.
     * @param type {string} the event name
     */
    this.trigger = function(type) {
      var callbacks, i, length, args;
      callbacks = listeners[type];
      if (!callbacks) {
        return;
      }
      // Slicing the arguments on every invocation of this method
      // can add a significant amount of overhead. Avoid the
      // intermediate object creation for the common case of a
      // single callback argument
      if (arguments.length === 2) {
        length = callbacks.length;
        for (i = 0; i < length; ++i) {
          callbacks[i].call(this, arguments[1]);
        }
      } else {
        args = [];
        i = arguments.length;
        for (i = 1; i < arguments.length; ++i) {
          args.push(arguments[i]);
        }
        length = callbacks.length;
        for (i = 0; i < length; ++i) {
          callbacks[i].apply(this, args);
        }
      }
    };
    /**
     * Destroys the stream and cleans up.
     */
    this.dispose = function() {
      listeners = {};
    };
  };
};

/**
 * Forwards all `data` events on this stream to the destination stream. The
 * destination stream should provide a method `push` to receive the data
 * events as they arrive.
 * @param destination {stream} the stream that will receive all `data` events
 * @param autoFlush {boolean} if false, we will not call `flush` on the destination
 *                            when the current stream emits a 'done' event
 * @see http://nodejs.org/api/stream.html#stream_readable_pipe_destination_options
 */
Stream.prototype.pipe = function(destination) {
  this.on('data', function(data) {
    destination.push(data);
  });

  this.on('done', function(flushSource) {
    destination.flush(flushSource);
  });

  return destination;
};

// Default stream functions that are expected to be overridden to perform
// actual work. These are provided by the prototype as a sort of no-op
// implementation so that we don't have to check for their existence in the
// `pipe` function above.
Stream.prototype.push = function(data) {
  this.trigger('data', data);
};

Stream.prototype.flush = function(flushSource) {
  this.trigger('done', flushSource);
};

module.exports = Stream;

},{}]},{},[8])(8)
});