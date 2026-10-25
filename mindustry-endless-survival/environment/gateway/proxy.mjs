import http from 'node:http';
const server=http.createServer({requestTimeout:0,headersTimeout:0},(req,res)=>{
  if(!['GET','POST'].includes(req.method)||!req.url.startsWith('/')||req.url.startsWith('//')){
    res.writeHead(400).end();return;
  }
  const upstream=http.request({hostname:'main',port:8080,path:req.url,method:req.method,
    headers:{authorization:req.headers.authorization??'', 'content-type':'application/json',
      ...(req.headers['content-length']?{'content-length':req.headers['content-length']}:{})}},reply=>{
    res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('aborted',()=>upstream.destroy());
  res.on('close',()=>upstream.destroy());
  req.pipe(upstream);
});
server.listen(8080,'0.0.0.0');
