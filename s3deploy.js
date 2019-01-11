const { info, error, logWithSpinner, stopSpinner } = require('@vue/cli-shared-utils')
const path = require('path')
const fs = require('fs-extra')
const mime = require('mime-types')
const globby = require('globby')
const AWS = require('aws-sdk')
const PromisePool = require('es6-promise-pool')
const zlib = require('zlib');

const S3 = new AWS.S3()
const deployDir = 'dist-deploy';

function contentTypeFor (filename) {
  return mime.lookup(filename) || 'application/octet-stream'
}

function mimeCharsetsLookup(mimeType, fallback) {
  // the node-mime library removed this method in v 2.0. This is the replacement
  // code for what was formerly mime.charsets.lookup
  return (/^text\/|^application\/(javascript|json)/).test(mimeType) ? 'UTF-8' : fallback;
}

async function createBucket (options) {
  let createParams = {
    Bucket: options.bucket,
    ACL: options.acl
  }

  // Create bucket
  try {
    await S3.createBucket(createParams).promise()
  } catch (createErr) {
    error(`Bucket: ${options.bucket} could not be created. AWS Error: ${createErr.toString()}.`)
    return false
  }

  info(`Bucket: ${options.bucket} created.`)
  return true
}

async function enableStaticHosting (options) {
  let staticParams = {
    Bucket: options.bucket,
    WebsiteConfiguration: {
      ErrorDocument: {
        Key: options.staticErrorPage
      },
      IndexDocument: {
        Suffix: options.staticIndexPage
      }
    }
  }

  // use custom WebsiteConfiguration if set
  if (options.staticWebsiteConfiguration) {
    staticParams.WebsiteConfiguration = options.staticWebsiteConfiguration
  }

  // enable static hosting
  try {
    await S3.putBucketWebsite(staticParams).promise()
    info(`Static Hosting is enabled.`)
  } catch (staticErr) {
    error(`Static Hosting could not be enabled on bucket: ${options.bucket}. AWS Error: ${staticErr.toString()}.`)
  }
}

async function bucketExists (options) {
  let headParams = { Bucket: options.bucket }
  let bucketExists = false

  try {
    bucketExists = await S3.headBucket(headParams).promise()
    info(`Bucket: ${options.bucket} exists.`)
  } catch (headErr) {
    let errStr = headErr.toString().toLowerCase()
    if (errStr.indexOf('forbidden') > -1) {
      error(`Bucket: ${options.bucket} exists, but you do not have permission to access it.`)
    } else if (errStr.indexOf('notfound') > -1) {
      if (options.createBucket) {
        info(`Bucket: ${options.bucket} does not exist, attempting to create.`)
        bucketExists = await createBucket(options)
      } else {
        error(`Bucket: ${options.bucket} does not exist.`)
      }
    } else {
      error(`Could not verify that bucket ${options.bucket} exists. AWS Error: ${headErr}.`)
    }
  }

  if (bucketExists && options.staticHosting) {
    await enableStaticHosting(options)
  }

  return bucketExists
}

function getAllFiles (pattern, assetPath) {
  return globby.sync(pattern, { cwd: assetPath }).map(file => path.join(assetPath, file))
}

async function invalidateDistribution (options) {
  const cloudfront = new AWS.CloudFront()
  const invalidationItems = options.cloudfrontMatchers.split(',')

  let params = {
    DistributionId: options.cloudfrontId,
    InvalidationBatch: {
      CallerReference: `vue-cli-plugin-s3-deploy-${Date.now().toString()}`,
      Paths: {
        Quantity: invalidationItems.length,
        Items: invalidationItems
      }
    }
  }

  logWithSpinner(`Invalidating CloudFront distribution: ${options.cloudfrontId}`)

  try {
    let data = await cloudfront.createInvalidation(params).promise()

    info(`Invalidation ID: ${data['Invalidation']['Id']}`)
    info(`Status: ${data['Invalidation']['Status']}`)
    info(`Call Reference: ${data['Invalidation']['InvalidationBatch']['CallerReference']}`)
    info(`See your AWS console for on-going status on this invalidation.`)
  } catch (err) {
    error('Cloudfront Error!')
    error(`Code: ${err.code}`)
    error(`Message: ${err.message}`)
    error(`AWS Request ID: ${err.requestId}`)
  }

  stopSpinner()
}

async function uploadFile ({ fileKey, fileBody, options, gzip }) {
  const pwaSupport = options.pwa && options.pwaFiles.split(',').includes(fileKey)
  let contentType = contentTypeFor(fileKey);
  const encoding = mimeCharsetsLookup(contentType);

  if (encoding) {
    contentType = `${contentType}; charset=${encoding.toLowerCase()}`;
  }

  let uploadParams = {
    Bucket: options.bucket,
    Key: fileKey,
    ACL: options.acl,
    Body: fileBody,
    ContentType: contentTypeFor(fileKey)
  }

  if (options.cacheControl) {
    uploadParams.CacheControl = options.cacheControl
  }

  if (gzip) {
    uploadParams.ContentEncoding = 'gzip'
  }

  if (pwaSupport) {
    uploadParams.CacheControl = 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
  }

  try {
    await S3.upload(uploadParams, options.uploadOptions).promise()
  } catch (uploadResultErr) {
    // pass full error with details back to promisePool callback
    throw new Error(`(${options.uploadCount}/${options.uploadTotal}) Upload failed: ${fileKey}. AWS Error: ${uploadResultErr.toString()}.`)
  }
}

function getAllFiles (assetPath, pattern = '**') {
  return globby.sync(pattern, { cwd: assetPath })
    .map(file => ({
      relative: file,
      absolute: path.join(assetPath, file)
    }));
}

function parseDeployPath (depPath) {
  let deployPath = depPath
  // We don't need a leading slash for root deploys on S3.
  if (deployPath.startsWith('/')) deployPath = deployPath.slice(1, deployPath.length)
  // But we do need to make sure there's a trailing one on the path.
  if (!deployPath.endsWith('/') && deployPath.length > 0) deployPath = deployPath + '/'

  return deployPath
}

function getFullPath (dir) {
  return path.join(process.cwd(), dir) + path.sep // path.sep appends a trailing / or \ depending on platform.
}


async function setupAWS(awsProfile, region) {
  const awsConfig = {
    region: region,
    httpOptions: {
      connectTimeout: 30 * 1000,
      timeout: 120 * 1000
    }
  }

  if (awsProfile.toString() !== 'default') {
    const credentials = new AWS.SharedIniFileCredentials({
      profile: awsProfile
    })

    await credentials.get((err) => {
      if (err) {
        throw new Error(err);
      }

      awsConfig.credentials = credentials
    })
  }

  AWS.config.update(awsConfig)
}

async function prepareDeploymentDirectory (assetPath, assetMatch) {
  const fullAssetPath = getFullPath(assetPath)
  const filesToCopy = getAllFiles(fullAssetPath, assetMatch)

  const copyPool = new PromisePool(() => {
    if (filesToCopy.length === 0) return null

    const file = filesToCopy.pop()
    const src = file.absolute
    const dist = getFullPath(deployDir) + file.relative

    return fs.copy(src, dist)
  }, 10);

  try {
    info('Creating deployment directory')
    await fs.emptyDir(getFullPath(deployDir))
    await copyPool.start()
    info('Deployment directory created.')
  } catch (err) {
    error('Deployment directory could not be created.')
    error(err)
  }
}

async function gzipFiles(filesToGzip) {
  const filesQueue = [...filesToGzip]

  const gzipPool = new PromisePool(() => {
    if (filesQueue.length === 0) return null

    const filePath = filesQueue.pop()
    const outputPath = `${filePath}.gz`
    const gzip = zlib.createGzip()

    return new Promise((resolve, reject) => {
      const input = fs.createReadStream(filePath)
      const output = fs.createWriteStream(outputPath)

      input.pipe(gzip).pipe(output)

      input.on('error', (err) => {
        reject(err)
      });

      output.on('error', (err) => {
        reject(err)
      });

      output.on('finish', () => {
        resolve()
      });
    }).then(() => fs.rename(outputPath, filePath))
  }, 10)

  try {
    info('Gzipping files')
    await gzipPool.start()
    info(`All ${filesToGzip.length} have been gzipped successfully.`)
  } catch (err) {
    error('Files haven\'t been gzipped properly.')
    error(err)
    process.exit(1)
  }
}

module.exports = async (options, api) => {
  info(`Options: ${JSON.stringify(options)}`)


  try {
    await setupAWS(options.awsProfile, options.region)
    info('AWS credentials confirmed')
  } catch (err) {
    error('Setting up AWS failed.')
    error(err)
    return
  }

  if (await bucketExists(options) === false) {
    error('Deployment terminated.')
    return
  }

  options.uploadOptions = { partSize: (5 * 1024 * 1024), queueSize: 4 }

  const deployDirPath = getFullPath(deployDir)
  const filesToDeploy = getAllFiles(deployDirPath)
  let filesToGzip = []

  const bucketDeployPath = parseDeployPath(options.deployPath)
  const uploadTotal = filesToDeploy.length
  let uploadCount = 0

  const remotePath = options.staticHosting
    ? `https://s3-${options.region}.amazonaws.com/${options.bucket}/`
    : `https://${options.bucket}.s3-website-${options.region}.amazonaws.com/`

  await prepareDeploymentDirectory(options.assetPath, options.assetMatch)

  if (options.gzip) {
    filesToGzip = getAllFiles(deployDirPath, options.gzipFilePattern)
      .map(file => file.absolute)
    info("Gzipping " + String(filesToGzip.length) + " files.")
    await gzipFiles(filesToGzip)
  }

  const uploadPool = new PromisePool(() => {
    if (filesToDeploy.length === 0) return null

    let filename = filesToDeploy.pop().absolute
    let fileStream = fs.readFileSync(filename)
    let fileKey = filename.replace(deployDirPath, '').replace(/\\/g, '/')
    let fullFileKey = `${bucketDeployPath}${fileKey}`

    info(`Uploading: ${fullFileKey}`);

    return uploadFile({
      fileKey: fullFileKey,
      fileBody: fileStream,
      options,
      gzip: filesToGzip.includes(filename)
    })
      .then(() => {
        uploadCount++

        let pwaSupport = options.pwa && options.pwaFiles.split(',').indexOf(fileKey) > -1
        let pwaStr = pwaSupport ? ' with cache disabled for PWA' : ''

        info(`(${uploadCount}/${uploadTotal}) Uploaded ${fullFileKey}${pwaStr}`)
      })
      .catch((e) => {
        error(`Upload failed: ${fullFileKey}`)
        error(e.toString())
      })
  }, parseInt(options.uploadConcurrency, 10))


  try {
    info(`Deploying ${uploadTotal} assets from ${deployDirPath} to ${remotePath}`)
    await uploadPool.start()
    info(`All ${uploadTotal} assets have been successfully deployed to ${remotePath}`)

    if (options.enableCloudfront) {
      invalidateDistribution(options)
    }
    if (uploadCount !== uploadTotal) {
      // Try to invalidate the distribution first and then check for uploaded file count.
      throw new Error(`Not all files were uploaded. ${uploadCount} out of ${uploadTotal} files were uploaded.`);
    }
    // Only output this when the invalidation was successful as well.
    info('Deployment complete.')
  } catch (uploadErr) {
    error('Deployment completed with errors.');
    error(`${uploadErr.toString()}`)
    process.exit(1)
  }

  /*

  let fullAssetPath = path.join(process.cwd(), options.assetPath) + path.sep // path.sep appends a trailing / or \ depending on platform.
  let fileList = getAllFiles(options.assetMatch, fullAssetPath)

  let deployPath = options.deployPath
  // We don't need a leading slash for root deploys on S3.
  if (deployPath.startsWith('/')) deployPath = deployPath.slice(1, deployPath.length)
  // But we do need to make sure there's a trailing one on the path.
  if (!deployPath.endsWith('/') && deployPath.length > 0) deployPath = deployPath + '/'

  let uploadCount = 0
  let uploadTotal = fileList.length

  let remotePath = `https://${options.bucket}.s3-website-${options.region}.amazonaws.com/`
  if (options.staticHosting) {
    remotePath = `https://s3-${options.region}.amazonaws.com/${options.bucket}/`
  }


  info(`Deploying ${fileList.length} assets from ${fullAssetPath} to ${remotePath}`)

  let nextFile = () => {
    if (fileList.length === 0) return null

    let filename = fileList.pop()
    let fileStream = fs.readFileSync(filename)
    let fileKey = filename.replace(fullAssetPath, '').replace(/\\/g, '/')

    let fullFileKey = `${deployPath}${fileKey}`

    return uploadFile(fullFileKey, fileStream, options)
    .then(() => {
      uploadCount++

      let pwaSupport = options.pwa && options.pwaFiles.split(',').indexOf(fileKey) > -1
      let pwaStr = pwaSupport ? ' with cache disabled for PWA' : ''

      info(`(${uploadCount}/${uploadTotal}) Uploaded ${fullFileKey}${pwaStr}`)
      // resolve()
    })
    .catch((e) => {
      error(`Upload failed: ${fullFileKey}`)
      error(e.toString())
      // reject(e)
    })
  }

  const uploadPool = new PromisePool(nextFile, parseInt(options.uploadConcurrency, 10))

  try {
    await uploadPool.start()
    info('Deployment complete.')

    if (options.enableCloudfront) {
      invalidateDistribution(options)
    }
  } catch (uploadErr) {
    error(`Deployment completed with errors.`)
    error(`${uploadErr.toString()}`)
  }*/
}
