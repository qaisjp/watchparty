// This assumes an installation of Docker exists at the Docker VM host
// and that host is configured to accept our SSH key
import { v4 as uuidv4 } from 'uuid';
import { VMManager, VM } from './base';
import { cloudInit, imageName } from './utils';
//@ts-ignore
import sshExec from 'ssh-exec';

const gatewayHost = process.env.DOCKER_VM_HOST;
const sshConfig = {
  user: process.env.DOCKER_VM_HOST_SSH_USER || 'root',
  host: gatewayHost,
  key: process.env.DOCKER_VM_HOST_SSH_KEY_BASE64
    ? new Buffer(process.env.DOCKER_VM_HOST_SSH_KEY_BASE64, 'base64')
    : undefined,
};

export class Docker extends VMManager {
  size = '';
  largeSize = '';
  redisQueueKey = 'availableListDocker';
  redisStagingKey = 'stagingListDocker';
  startVM = async (name: string) => {
    return new Promise<string>(async (resolve, reject) => {
      const password = uuidv4();
      sshExec(
        `
        #!/bin/bash
        set -e
        PORT=$(comm -23 <(seq 5000 5063 | sort) <(ss -Htan | awk '{print $4}' | cut -d':' -f2 | sort -u) | shuf | head -n 1)
        INDEX=$(($PORT - 5000))
        UDP_START=$((59000+$INDEX*100))
        UDP_END=$((59099+$INDEX*100))
        docker run -d --rm --name=${password} -p $PORT:$PORT -p $UDP_START-$UDP_END:$UDP_START-$UDP_END/udp -v /etc/letsencrypt:/etc/letsencrypt -l vbrowser -l index=$INDEX --log-opt max-size=1g --shm-size=1g --cap-add="SYS_ADMIN" -e NEKO_KEY="/etc/letsencrypt/live/${gatewayHost}/privkey.pem" -e NEKO_CERT="/etc/letsencrypt/live/${gatewayHost}/fullchain.pem" -e DISPLAY=":$INDEX.0" -e NEKO_SCREEN="1280x720@30" -e NEKO_PASSWORD=${password} -e NEKO_PASSWORD_ADMIN=${password} -e NEKO_BIND=":$PORT" -e NEKO_EPR=":$UDP_START-$UDP_END" howardc93/vbrowser
        `,
        sshConfig,
        (err: string, stdout: string) => {
          if (err) {
            return reject(err);
          }
          console.log(stdout);
          resolve(stdout.trim());
        }
      );
    });
  };

  terminateVM = async (id: string) => {
    return new Promise<void>((resolve, reject) => {
      sshExec(
        `docker rm -f ${id}`,
        sshConfig,
        (err: string, stdout: string) => {
          if (err) {
            return reject(err);
          }
          resolve();
        }
      );
    });
  };

  rebootVM = async (id: string) => {
    return await this.terminateVM(id);
  };

  // Override the base method, since we don't need to reuse docker containers
  resetVM = async (id: string) => {
    return await this.terminateVM(id);
  };

  getVM = async (id: string) => {
    return new Promise<VM>((resolve, reject) => {
      sshExec(
        `docker inspect ${id}`,
        sshConfig,
        (err: string, stdout: string) => {
          if (err) {
            return reject(err);
          }
          const data = JSON.parse(stdout)[0];
          if (!data) {
            return reject(new Error('no container with this ID found'));
          }
          let server = this.mapServerObject(data);
          resolve(server);
        }
      );
    });
  };

  listVMs = async (filter?: string) => {
    return new Promise<VM[]>((resolve, reject) => {
      sshExec(
        `docker inspect $(docker ps --filter label=vbrowser --quiet --no-trunc)`,
        sshConfig,
        (err: string, stdout: string) => {
          if (err) {
            return reject(err);
          }
          if (!stdout) {
            return [];
          }
          const data = JSON.parse(stdout);
          return resolve(data.map(this.mapServerObject));
        }
      );
    });
  };

  mapServerObject = (server: any): VM => ({
    id: server.Id,
    pass: server.Name?.slice(1),
    host: `${gatewayHost}:${5000 + Number(server.Config?.Labels?.index)}`,
    private_ip: '',
    state: server.State?.Status,
    tags: server.Config?.Labels,
    creation_date: server.State?.StartedAt,
    provider: this.getRedisQueueKey(),
    large: this.isLarge,
  });
}
