import express, { Router } from 'express';
import { readFileSync } from 'node:fs';
import { getAbsoluteFSPath } from 'swagger-ui-dist';

const specification=JSON.parse(readFileSync(new URL('../docs/openapi.json',import.meta.url),'utf8'));
const html=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nguyễn Hoài Nam · API chấm công</title><link rel="stylesheet" href="/v1/docs-assets/swagger-ui.css"><link rel="stylesheet" href="/v1/docs-style.css"></head><body><header><strong>HN / SỔ CA</strong><span>Nguyễn Hoài Nam · 2380601398 · Nhóm 8</span><a href="/v1/health" target="_blank" rel="noopener">Kiểm tra kết nối ↗</a></header><div id="swagger-ui"></div><script src="/v1/docs-assets/swagger-ui-bundle.js"></script><script src="/v1/docs-init.js"></script></body></html>`;
const init=`window.addEventListener('DOMContentLoaded',()=>{window.ui=SwaggerUIBundle({url:'/v1/openapi.json',dom_id:'#swagger-ui',deepLinking:true,docExpansion:'list',filter:true,persistAuthorization:false,validatorUrl:null,queryConfigEnabled:false,withCredentials:false,tryItOutEnabled:false,displayRequestDuration:true,defaultModelsExpandDepth:-1,requestInterceptor:request=>{const target=new URL(request.url,location.origin);if(target.origin!==location.origin||!target.pathname.startsWith('/v1/'))throw new Error('Chỉ gửi yêu cầu tới API này.');request.credentials='omit';return request;}});});`;
const css=`body{margin:0;background:#fffaf6}header{padding:18px 28px;display:flex;gap:22px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #e6d4d9;color:#402d37;font:14px system-ui}header strong{color:#9d385b;letter-spacing:2px}header a{margin-left:auto;color:#83304d}.swagger-ui .info .title{color:#402d37}.swagger-ui .info{margin:28px 0}.swagger-ui .wrapper{max-width:1200px}.swagger-ui .scheme-container{background:#fff6f8}.swagger-ui .btn.authorize{color:#83304d;border-color:#83304d}.swagger-ui .btn.authorize svg{fill:#83304d}.swagger-ui .opblock-summary-path{overflow-wrap:anywhere}@media(max-width:600px){header{padding:16px;gap:10px}header a{margin-left:0}.swagger-ui .opblock .opblock-summary-path{font-size:12px;max-width:65%}}`;
export function createApiDocs(){
 const router=Router();
 router.get(['/v1/index.html','/v1/','/v1'],(_req,res)=>res.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'").type('html').send(html));
 router.get('/v1/openapi.json',(_req,res)=>res.json(specification));
 router.get('/v1/docs-init.js',(_req,res)=>res.type('application/javascript').send(init));
 router.get('/v1/docs-style.css',(_req,res)=>res.type('css').send(css));
 const assets=getAbsoluteFSPath();
 router.get('/v1/docs-assets/:file',(req,res,next)=>{
  if(!['swagger-ui.css','swagger-ui-bundle.js'].includes(req.params.file))return res.status(404).json({error:{code:'NOT_FOUND',message:'Không tìm thấy tài nguyên.'}});
  return res.sendFile(req.params.file,{root:assets},error=>{if(error)next(error);});
 });
 return router;
}
