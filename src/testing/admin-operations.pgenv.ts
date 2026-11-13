import {mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
const url=process.env.QA_ISOLATED_PG_URL;
export const opts={skip:!!url&&url===process.env.DATABASE_URL&&/@(127\.0\.0\.1|localhost):55432\//.test(url)?false:'Requires isolated local PostgreSQL on :55432'};
process.env.JWT_SECRET??='synthetic-test-secret';process.env.OPENAI_API_KEY??='synthetic';
let setup:Promise<any>|null=null;
export async function env(){return setup??=(async()=>{
 const {prisma}=await import('../config/db');
 mock.module('../middlewares/auth.middleware',{namedExports:{authenticate:async(req:any,res:any,next:any)=>{const u=await prisma.user.findUnique({where:{id:String(req.headers['x-test-user']||'missing')}});if(!u)return res.status(401).json({success:false});req.user={...u,userId:u.id};next();},requireActiveUser:(_q:any,_r:any,n:any)=>n()}});
 const express=(await import('express')).default;
 const routes=await import('../routes/admin-operations.routes');
 const {globalErrorHandler}=await import('../middlewares/error.middleware');
 const app=express();app.use(express.json());app.use('/admin/operations',routes.default);app.use('/public/content',routes.publicContentRouter);app.use(globalErrorHandler as any);
 const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as AddressInfo).port;
 const call=async(method:string,path:string,who?:string,body?:unknown)=>{const res=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'content-type':'application/json',connection:'close',...(who?{'x-test-user':who}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,json:await res.json() as any};};
 const mkUser=(accountType:any='ADMIN',tag='u')=>prisma.user.create({data:{accountType,status:'ACTIVE',firstName:tag,lastName:'QA',email:`${randomUUID()}@pg.test`,roles:[accountType==='SUPER_ADMIN'?'SUPER_ADMIN':accountType==='ADMIN'?'ADMIN':accountType.startsWith('PROVIDER')?'PROVIDER':'CLIENT'],activeRole:accountType==='SUPER_ADMIN'?'SUPER_ADMIN':accountType==='ADMIN'?'ADMIN':accountType.startsWith('PROVIDER')?'PROVIDER':'CLIENT'}});
 return {prisma,server,call,mkUser,sa:await mkUser('SUPER_ADMIN','super')};
})();}
export async function mkStaff(e:any,permissions:string[],tag:string){const user=await e.mkUser('ADMIN',tag);const role=await e.prisma.adminRole.create({data:{name:`QA-${randomUUID()}`,nameKey:randomUUID(),createdById:e.sa.id,permissions}});await e.prisma.adminStaff.create({data:{userId:user.id,roleId:role.id}});return {user,role};}
export async function closeEnv(){if(!setup)return;const e=await setup;e.server.closeAllConnections?.();await new Promise(r=>e.server.close(r));await e.prisma.$disconnect();}
