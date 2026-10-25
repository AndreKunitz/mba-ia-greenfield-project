import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
  type HttpRedirectResponse,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { PublicVideoResponseDto } from './dto/public-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { UploadStateResponseDto } from './dto/upload-state-response.dto';
import { UploadUrlsResponseDto } from './dto/upload-urls-response.dto';
import { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { PublicIdPipe } from './public-id.pipe';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the authenticated user channel and creates the multipart upload in the object storage. No video bytes go through the API: the client then asks for signed part URLs and sends each part straight to the storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or unsupported video format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the maximum allowed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createVideo(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Get(':publicId/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the state of an upload in progress',
    description:
      'Lists the parts the storage already holds, so an interrupted upload can resume. Only the video owner, and only while the video is a draft.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload state',
    type: UploadStateResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadState(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<UploadStateResponseDto> {
    return this.videosService.getUploadState(user.sub, publicId);
  }

  @Post(':publicId/upload-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns one signed URL per requested part. The client sends each part with an HTTP PUT straight to the storage and keeps the ETag header of each response.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed part URLs',
    type: UploadUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'The video is no longer accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', PublicIdPipe) publicId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<UploadUrlsResponseDto> {
    return this.videosService.signUploadParts(user.sub, publicId, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Closes the multipart upload, checks the stored size against the declared one and queues the video for processing. The answer is asynchronous: poll the video status until it is ready.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed, video queued for processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is not accepting uploads, or parts are missing or do not match',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'The stored size differs from the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', PublicIdPipe) publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }

  @SkipThrottle()
  @Get(':publicId/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the processing status of a video',
    description:
      'Status of the pipeline for the video owner, in any state. This is how the owner follows a video from processing to ready or error.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status',
    type: VideoStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<VideoStatusResponseDto> {
    return this.videosService.getOwnerStatus(user.sub, publicId);
  }

  @SkipThrottle()
  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get the public data of a video',
    description:
      'Title, duration and metadata of a video that is ready. Videos in any other state are not found for the public.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video data',
    type: PublicVideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<PublicVideoResponseDto> {
    return this.videosService.getPublicVideo(publicId);
  }

  @SkipThrottle()
  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived signed URL of the object storage. The storage serves the bytes and answers Range requests with 206 Partial Content, so playback starts without downloading the whole file. Only for videos that are ready.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the signed URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<HttpRedirectResponse> {
    return {
      url: await this.videosService.getStreamUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @SkipThrottle()
  @Public()
  @Get(':publicId/download')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Download the original video file',
    description:
      'Redirects to a short-lived signed URL that makes the browser save the file under its original name. Only for videos that are ready.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the signed URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<HttpRedirectResponse> {
    return {
      url: await this.videosService.getDownloadUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @SkipThrottle()
  @Public()
  @Get(':publicId/thumbnail')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the thumbnail of a video',
    description:
      'Redirects to a short-lived signed URL of the JPEG thumbnail generated from a frame of the video. Only for videos that are ready.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the signed URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, not ready or without thumbnail',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId', PublicIdPipe) publicId: string,
  ): Promise<HttpRedirectResponse> {
    return {
      url: await this.videosService.getThumbnailUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }
}
